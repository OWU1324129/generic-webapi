const express = require('express');
const fs = require('fs');
// API Key などの環境変数は .env.local から読み込む
require('dotenv').config({ path: '.env.local' });

const app = express();
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json());
app.use(express.static('public'));

// ===== 設定 =====
// 利用するLLMプロバイダを選択します（'openai' または 'gemini'）
const PROVIDER = 'openai';

// プロバイダごとに利用するモデル
const MODELS = {
    openai: 'gpt-5.5',        // OpenAI（デフォルト）
    gemini: 'gemini-3.5-flash', // Google Gemini
};
const MODEL = MODELS[PROVIDER];

let promptTemplate;
try {
    promptTemplate = fs.readFileSync('prompt.md', 'utf8');
} catch (error) {
    console.error('Error reading prompt.md:', error);
    process.exit(1);
}

let outfitPromptTemplate;
try {
    outfitPromptTemplate = fs.readFileSync('gift-prompt.md', 'utf8');
} catch (error) {
    console.error('Error reading gift-prompt.md:', error);
    process.exit(1);
}

const OPENAI_API_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';

// public/ 内の .html 一覧を返す（index.html がこの一覧を使ってリンクを表示する）
app.get('/api/pages', (req, res) => {
    const files = fs.readdirSync('public')
        .filter(name => name.endsWith('.html') && name !== 'index.html');
    res.json(files);
});

// 問題数の上限（過剰なリクエストでトークンを浪費しないようにする）
const MAX_COUNT = 20;

app.post('/api/', async (req, res) => {
    try {
        // title と、変数置換に使うその他のキーを受け取る
        // （prompt.md がプロンプトを定義するので、リクエストでの上書きは許可しない）
        const { title = 'Generated Content', ...variables } = req.body;

        // count が指定されている場合は 1〜MAX_COUNT の範囲に収める
        if (variables.count !== undefined) {
            const count = Number(variables.count);
            if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
                return res.status(400).json({
                    error: `count must be an integer between 1 and ${MAX_COUNT}`,
                });
            }
        }

        // prompt.md のテンプレート変数 ${key} をリクエストの値で置換する
        const finalPrompt = fillTemplate(promptTemplate, variables);

        let result;
        if (PROVIDER === 'openai') {
            result = await callOpenAI(finalPrompt);
        } else if (PROVIDER === 'gemini') {
            result = await callGemini(finalPrompt);
        } else {
            return res.status(400).json({ error: 'Invalid provider configuration' });
        }

        res.json({
            title: title,
            data: result,
        });

    } catch (error) {
        // 詳細はサーバーログにのみ出力し、クライアントには汎用メッセージを返す
        console.error('API Error:', error);
        res.status(500).json({ error: 'Failed to generate content. Please try again.' });
    }
});

app.post('/api/outfits', handleOutfitRequest);
// 旧URLからの呼び出しが残っていても同じ処理で受ける
app.post('/api/gifts', handleOutfitRequest);
app.get('/api/weather', handleWeatherRequest);
app.post('/api/weather-outfits', handleWeatherOutfitRequest);
app.post('/api/idol/create', handleIdolCreateRequest);
app.post('/api/idol/audition', handleIdolAuditionRequest);
app.post('/api/idol/training', handleIdolTrainingRequest);

async function handleOutfitRequest(req, res) {
    try {
        const input = validateOutfitRequest(req.body);
        const finalPrompt = fillTemplate(outfitPromptTemplate, input);
        const recommendations = await callOpenAI(finalPrompt);
        res.json({
            title: 'コーディネートAI',
            data: recommendations,
        });
    } catch (error) {
        console.error('Outfit API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : 'コーディネートの生成に失敗しました。サーバーログを確認してください。'
        });
    }
}

// prompt.md 内の ${key} を variables の値で安全に置換する
function fillTemplate(template, variables) {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
        return Object.prototype.hasOwnProperty.call(variables, key)
            ? String(variables[key])
            : match; // 対応する値がなければそのまま残す
    });
}

function validateOutfitRequest(body) {
    const gender = cleanText(body.gender, 20);
    const age = Number(body.age);
    const temperature = Number(body.temperature);
    const weather = cleanText(body.weather, 40);
    const occasion = cleanText(body.occasion, 60);
    const style = cleanText(body.style, 60);
    const notes = cleanText(body.notes || '', 160);

    if (!gender) {
        throwBadRequest('gender is required');
    }
    if (!Number.isInteger(age) || age < 1 || age > 120) {
        throwBadRequest('age must be an integer between 1 and 120');
    }
    if (!Number.isInteger(temperature) || temperature < -40 || temperature > 50) {
        throwBadRequest('temperature must be an integer between -40 and 50');
    }
    if (!weather) {
        throwBadRequest('weather is required');
    }
    if (!occasion) {
        throwBadRequest('occasion is required');
    }
    if (!style) {
        throwBadRequest('style is required');
    }

    return { gender, age, temperature, weather, occasion, style, notes };
}

function cleanText(value, maxLength) {
    if (typeof value !== 'string') {
        return '';
    }
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function throwBadRequest(message) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
}

async function handleWeatherRequest(req, res) {
    try {
        const location = await resolveWeatherLocation(req.query);
        const weather = await fetchCurrentWeather(location);

        res.json({
            title: '今日の天気',
            data: weather,
        });
    } catch (error) {
        console.error('Weather API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : '天気データの取得に失敗しました。'
        });
    }
}

function handleWeatherOutfitRequest(req, res) {
    try {
        const weather = validateWeatherData(req.body.weather);
        const occasion = cleanText(req.body.occasion, 60);

        if (!occasion) {
            throwBadRequest('occasion is required');
        }

        res.json({
            title: '今日のコーデ提案',
            data: buildWeatherOutfits(weather, occasion),
        });
    } catch (error) {
        console.error('Weather outfit API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : 'コーデ提案の生成に失敗しました。'
        });
    }
}

async function resolveWeatherLocation(query) {
    const lat = Number(query.lat);
    const lon = Number(query.lon);
    const city = cleanText(query.city || '', 80);

    if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
            latitude: lat,
            longitude: lon,
            name: cleanText(query.name || '現在地', 80) || '現在地',
            country: cleanText(query.country || '', 40),
        };
    }

    if (!city) {
        throwBadRequest('city or lat/lon is required');
    }

    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ja&format=json`;
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error('Geocoding API error');
    }

    const data = await response.json();
    const result = data.results && data.results[0];
    if (!result) {
        throwBadRequest('city was not found');
    }

    return {
        latitude: result.latitude,
        longitude: result.longitude,
        name: result.name,
        country: result.country || '',
    };
}

async function fetchCurrentWeather(location) {
    const params = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
        timezone: 'auto',
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
    if (!response.ok) {
        throw new Error('Forecast API error');
    }

    const data = await response.json();
    const current = data.current;
    if (!current) {
        throw new Error('Forecast API returned no current weather');
    }

    return {
        location: location.name,
        country: location.country,
        time: current.time,
        temperature: Math.round(Number(current.temperature_2m)),
        apparentTemperature: Math.round(Number(current.apparent_temperature)),
        humidity: Math.round(Number(current.relative_humidity_2m)),
        precipitation: Number(current.precipitation || 0),
        windSpeed: Math.round(Number(current.wind_speed_10m)),
        weatherCode: Number(current.weather_code),
        weather: weatherCodeToLabel(Number(current.weather_code)),
    };
}

function validateWeatherData(value) {
    if (!value || typeof value !== 'object') {
        throwBadRequest('weather is required');
    }

    return {
        location: cleanText(value.location || '取得地点', 80),
        country: cleanText(value.country || '', 40),
        time: cleanText(value.time || '', 40),
        temperature: Number(value.temperature),
        apparentTemperature: Number(value.apparentTemperature),
        humidity: Number(value.humidity),
        precipitation: Number(value.precipitation || 0),
        windSpeed: Number(value.windSpeed || 0),
        weatherCode: Number(value.weatherCode || 0),
        weather: cleanText(value.weather || '不明', 40),
    };
}

function buildWeatherOutfits(weather, occasion) {
    const weatherFlags = getWeatherFlags(weather);
    const base = getTemperatureBase(weather.apparentTemperature);
    const occasionSet = getOccasionSet(occasion);
    const weatherItems = getWeatherItems(weatherFlags);

    return [
        {
            title: `${occasionSet.label}の定番バランス`,
            items: [base.top, base.bottom, base.outer, occasionSet.shoes, weatherItems.main].filter(Boolean),
            point: `${weather.weather}・体感${weather.apparentTemperature}度に合わせて、温度調整しやすい組み合わせです。`,
            caution: weatherItems.caution,
        },
        {
            title: 'きれいめ寄せ',
            items: [base.cleanTop, occasionSet.cleanBottom, base.lightOuter, occasionSet.cleanShoes, weatherItems.sub].filter(Boolean),
            point: `${occasionSet.label}でも崩れすぎない印象に寄せます。屋内外の移動がある日向けです。`,
            caution: weather.windSpeed >= 25 ? '風が強めなので、広がりやすい服や軽すぎる帽子は避けると安定します。' : weatherItems.caution,
        },
        {
            title: '動きやすさ重視',
            items: [base.easyTop, base.easyBottom, occasionSet.easyShoes, weatherItems.main, weatherItems.extra].filter(Boolean),
            point: `歩く時間が長くなっても疲れにくい構成です。${base.temperatureNote}`,
            caution: weather.humidity >= 75 ? '湿度が高いので、肌離れのよい素材を選ぶと不快感が減ります。' : weatherItems.caution,
        },
    ];
}

function getWeatherFlags(weather) {
    return {
        rainy: weather.precipitation > 0 || [51, 53, 55, 61, 63, 65, 80, 81, 82, 95, 96, 99].includes(weather.weatherCode),
        snowy: [71, 73, 75, 77, 85, 86].includes(weather.weatherCode),
        windy: weather.windSpeed >= 25,
        humid: weather.humidity >= 75,
    };
}

function getTemperatureBase(apparentTemperature) {
    if (apparentTemperature <= 5) {
        return {
            top: '厚手ニット',
            cleanTop: 'タートルネック',
            easyTop: '保温インナーとスウェット',
            bottom: '裏起毛パンツ',
            easyBottom: '暖かいストレートパンツ',
            outer: 'ダウンまたは中綿コート',
            lightOuter: 'ウールコート',
            temperatureNote: '体感温度が低いので、防寒を優先してください。',
        };
    }
    if (apparentTemperature <= 14) {
        return {
            top: '長袖カットソー',
            cleanTop: '薄手ニット',
            easyTop: 'ロンTとシャツ',
            bottom: 'デニムまたはチノパン',
            easyBottom: 'ゆとりのあるパンツ',
            outer: '軽めのジャケット',
            lightOuter: 'カーディガン',
            temperatureNote: '朝晩の冷えに備えて羽織りを持つと安定します。',
        };
    }
    if (apparentTemperature <= 23) {
        return {
            top: '薄手シャツ',
            cleanTop: 'ブラウスまたはきれいめシャツ',
            easyTop: '通気性のよいTシャツ',
            bottom: 'ワイドパンツ',
            easyBottom: 'イージーパンツ',
            outer: '薄手カーディガン',
            lightOuter: 'シャツジャケット',
            temperatureNote: '日中は軽め、屋内の冷房対策に薄い羽織りが便利です。',
        };
    }
    return {
        top: '半袖トップス',
        cleanTop: 'さらっとした半袖シャツ',
        easyTop: '吸湿速乾Tシャツ',
        bottom: '軽い素材のパンツ',
        easyBottom: '薄手パンツ',
        outer: '',
        lightOuter: '薄手の羽織り',
        temperatureNote: '暑さ対策として通気性と汗処理を優先してください。',
    };
}

function getOccasionSet(occasion) {
    const sets = {
        '通勤・通学': {
            label: '通勤・通学',
            shoes: '歩きやすい革靴またはスニーカー',
            cleanBottom: 'センタープレスパンツ',
            cleanShoes: 'ローファー',
            easyShoes: 'クッション性のあるスニーカー',
        },
        '友達と外出': {
            label: '友達と外出',
            shoes: 'スニーカー',
            cleanBottom: 'きれいめデニム',
            cleanShoes: 'フラットシューズ',
            easyShoes: '履き慣れたスニーカー',
        },
        'デート': {
            label: 'デート',
            shoes: '上品なフラットシューズ',
            cleanBottom: '落ち感のあるパンツまたはスカート',
            cleanShoes: 'ローファーまたはパンプス',
            easyShoes: 'きれいめスニーカー',
        },
        '買い物': {
            label: '買い物',
            shoes: '歩きやすいスニーカー',
            cleanBottom: '動きやすいテーパードパンツ',
            cleanShoes: '軽いローファー',
            easyShoes: 'クッション性の高いスニーカー',
        },
        '屋外イベント': {
            label: '屋外イベント',
            shoes: '汚れに強いスニーカー',
            cleanBottom: '動きやすいパンツ',
            cleanShoes: '防水寄りのシューズ',
            easyShoes: '滑りにくいスニーカー',
        },
    };

    return sets[occasion] || sets['友達と外出'];
}

function getWeatherItems(flags) {
    if (flags.snowy) {
        return {
            main: '防滑シューズ',
            sub: '撥水アウター',
            extra: '手袋',
            caution: '雪対策として滑りにくい靴と撥水素材を優先してください。',
        };
    }
    if (flags.rainy) {
        return {
            main: '折りたたみ傘',
            sub: '撥水バッグ',
            extra: '濡れても乾きやすい素材',
            caution: '雨に備えて、裾が長すぎるボトムスや水に弱い靴は避けると安心です。',
        };
    }
    if (flags.windy) {
        return {
            main: '風を通しにくい羽織り',
            sub: 'コンパクトなバッグ',
            extra: '',
            caution: '風が強いので、収まりのよいシルエットがおすすめです。',
        };
    }
    if (flags.humid) {
        return {
            main: 'リネン・ドライ素材',
            sub: '汗じみが目立ちにくい色',
            extra: '',
            caution: '湿度が高いため、厚手素材や重ね着しすぎは避けてください。',
        };
    }
    return {
        main: '小物は軽め',
        sub: '季節感のあるバッグ',
        extra: '',
        caution: '大きな天気リスクは少ないので、予定に合わせた動きやすさを優先できます。',
    };
}

function weatherCodeToLabel(code) {
    if (code === 0) return '快晴';
    if ([1, 2].includes(code)) return '晴れ';
    if (code === 3) return '曇り';
    if ([45, 48].includes(code)) return '霧';
    if ([51, 53, 55, 56, 57].includes(code)) return '霧雨';
    if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
    if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
    if ([95, 96, 99].includes(code)) return '雷雨';
    return '不明';
}

function handleIdolCreateRequest(req, res) {
    try {
        const input = validateIdolCreateRequest(req.body);
        const idol = createIdol(input);

        res.json({
            title: 'アイドル育成プロジェクト',
            data: idol,
        });
    } catch (error) {
        console.error('Idol create API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : 'キャラクター生成に失敗しました。'
        });
    }
}

function handleIdolAuditionRequest(req, res) {
    try {
        const input = validateIdolAuditionRequest(req.body);
        const result = runAudition(input.idol, input.auditionType);

        res.json({
            title: 'オーディション結果',
            data: result,
        });
    } catch (error) {
        console.error('Idol audition API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : 'オーディション処理に失敗しました。'
        });
    }
}

function handleIdolTrainingRequest(req, res) {
    try {
        const input = validateIdolTrainingRequest(req.body);
        const result = trainIdol(input.idol, input.trainingType);

        res.json({
            title: '練習結果',
            data: result,
        });
    } catch (error) {
        console.error('Idol training API Error:', error);
        const status = error.statusCode || 500;
        res.status(status).json({
            error: status === 400
                ? error.message
                : '練習処理に失敗しました。'
        });
    }
}

function validateIdolCreateRequest(body) {
    const personality = cleanText(body.personality, 40);
    const concept = cleanText(body.concept, 80);
    const specialty = cleanText(body.specialty, 40);
    const age = Number(body.age);

    if (!personality) {
        throwBadRequest('personality is required');
    }
    if (!Number.isInteger(age) || age < 10 || age > 40) {
        throwBadRequest('age must be an integer between 10 and 40');
    }
    if (!concept) {
        throwBadRequest('concept is required');
    }
    if (!specialty) {
        throwBadRequest('specialty is required');
    }

    return { personality, age, concept, specialty };
}

function validateIdolAuditionRequest(body) {
    const idol = body.idol;
    const auditionType = cleanText(body.auditionType, 40);
    const allowedTypes = ['local', 'media', 'festival', 'debut'];

    if (!idol || typeof idol !== 'object') {
        throwBadRequest('idol is required');
    }
    if (!allowedTypes.includes(auditionType)) {
        throwBadRequest('auditionType is invalid');
    }

    return { idol, auditionType };
}

function validateIdolTrainingRequest(body) {
    const idol = body.idol;
    const trainingType = cleanText(body.trainingType, 40);
    const allowedTypes = ['vocal', 'dance', 'rap', 'expression', 'stamina', 'balanced', 'rest'];

    if (!idol || typeof idol !== 'object') {
        throwBadRequest('idol is required');
    }
    if (!allowedTypes.includes(trainingType)) {
        throwBadRequest('trainingType is invalid');
    }

    return { idol, trainingType };
}

function createIdol(input) {
    const seedText = `${input.personality}-${input.age}-${input.concept}-${input.specialty}`;
    const seed = hashText(seedText);
    const rand = seededRandom(seed);
    const specialtyKey = normalizeSpecialty(input.specialty);
    const names = ['星乃ミオ', '月城リナ', '朝比奈ユイ', '七瀬カナ', '白石ノア', '天宮サラ', '花咲メイ', '一ノ瀬ルカ'];
    const catchphrases = [
        'ステージの一秒を全部きらめきに変えます',
        'まだ小さな声でも、会場の奥まで届けます',
        '夢を見せるだけで終わらせません',
        '努力の跡まで好きになってもらえる人になります'
    ];
    const base = 34 + Math.floor(rand() * 18);
    const stats = {
        vocal: clampStat(base + specialtyBonus(specialtyKey, 'vocal') + personalityBonus(input.personality, 'vocal')),
        dance: clampStat(base + specialtyBonus(specialtyKey, 'dance') + personalityBonus(input.personality, 'dance')),
        rap: clampStat(base + specialtyBonus(specialtyKey, 'rap') + personalityBonus(input.personality, 'rap')),
        expression: clampStat(base + specialtyBonus(specialtyKey, 'expression') + personalityBonus(input.personality, 'expression')),
        stamina: clampStat(base + Math.floor(rand() * 12) + ageStaminaBonus(input.age))
    };

    return {
        id: `idol-${Date.now()}-${seed}`,
        name: names[seed % names.length],
        personality: input.personality,
        age: input.age,
        concept: input.concept,
        specialty: input.specialty,
        profile: buildProfile(input, stats),
        catchphrase: catchphrases[(seed + input.age) % catchphrases.length],
        stats,
        fans: 120 + Math.floor(rand() * 180),
        auditions: 0,
        weeks: 1,
        rank: '練習生',
        debutReady: false,
        debuted: false,
        fatigue: 12,
        morale: 68,
        festivalPasses: 0,
        pendingTraining: null,
        history: []
    };
}

function runAudition(idol, auditionType) {
    const current = normalizeIdol(idol);
    const audition = getAuditionConfig(auditionType);
    const average = weightedScore(current.stats, audition.weights);
    const experience = Math.min(12, current.auditions * 2);
    const condition = calculateCondition(current);
    const score = clampScore(Math.round(average + experience + condition.scoreModifier + deterministicSwing(current.id, current.auditions, auditionType)));
    const passed = auditionType === 'debut'
        ? isDebutReady(current)
        : score >= audition.passLine;
    const growth = calculateGrowth(current, audition, passed);
    const updatedStats = applyGrowth(current.stats, growth);
    const gainedFans = Math.max(20, Math.round((passed ? audition.fans : audition.fans * 0.42) + score * audition.fanRate));
    const nextFans = current.fans + gainedFans;
    const nextAuditions = current.auditions + 1;
    const nextFestivalPasses = current.festivalPasses + (auditionType === 'festival' && passed ? 1 : 0);
    const nextFatigue = clampMeter(current.fatigue + audition.fatigue + (passed ? 4 : 8));
    const nextMorale = clampMeter(current.morale + (passed ? audition.morale : -10));
    const nextRank = decideRank(nextFans, updatedStats, passed, auditionType);
    const debuted = current.debuted || (auditionType === 'debut' && passed);
    const debutReady = debuted || isDebutReady({
        ...current,
        stats: updatedStats,
        fans: nextFans,
        auditions: nextAuditions,
        festivalPasses: nextFestivalPasses,
        fatigue: nextFatigue,
        morale: nextMorale
    });
    const improvement = analyzeImprovement(current, audition, score, passed, condition);
    const historyItem = {
        type: 'audition',
        week: current.weeks,
        name: audition.name,
        score,
        passed,
        fans: gainedFans,
        fatigue: nextFatigue - current.fatigue,
        morale: nextMorale - current.morale,
        comment: buildJudgeComment(current, audition, score, passed, growth),
        improvement
    };
    const updatedIdol = {
        ...current,
        stats: updatedStats,
        fans: nextFans,
        auditions: nextAuditions,
        weeks: current.weeks + 1,
        rank: debuted ? 'デビュー決定' : nextRank,
        debutReady,
        debuted,
        fatigue: nextFatigue,
        morale: nextMorale,
        festivalPasses: nextFestivalPasses,
        pendingTraining: debuted ? null : improvement.training,
        history: [historyItem, ...current.history].slice(0, 8)
    };

    return {
        idol: updatedIdol,
        result: historyItem,
        unlockedDebut: debutReady && !current.debutReady,
    };
}

function trainIdol(idol, trainingType) {
    const current = normalizeIdol(idol);
    if (current.debuted) {
        throwBadRequest('debuted idol cannot train');
    }

    const training = getTrainingConfig(trainingType);
    const growth = calculateTrainingGrowth(trainingType, current);
    const updatedStats = applyGrowth(current.stats, growth);
    const nextFans = current.fans + training.fans;
    const nextFatigue = clampMeter(current.fatigue + training.fatigue);
    const nextMorale = clampMeter(current.morale + training.morale);
    const debutReady = isDebutReady({
        ...current,
        stats: updatedStats,
        fans: nextFans,
        fatigue: nextFatigue,
        morale: nextMorale
    });
    const historyItem = {
        type: 'training',
        week: current.weeks,
        name: training.name,
        growth,
        fans: training.fans,
        fatigue: nextFatigue - current.fatigue,
        morale: nextMorale - current.morale,
        comment: buildTrainingComment(trainingType, growth)
    };
    const updatedIdol = {
        ...current,
        stats: updatedStats,
        fans: nextFans,
        weeks: current.weeks + 1,
        rank: decideRank(nextFans, updatedStats, false, 'training'),
        debutReady,
        fatigue: nextFatigue,
        morale: nextMorale,
        pendingTraining: null,
        history: [historyItem, ...current.history].slice(0, 8)
    };

    return {
        idol: updatedIdol,
        result: historyItem,
        unlockedDebut: debutReady && !current.debutReady,
    };
}

function normalizeIdol(idol) {
    return {
        id: cleanText(idol.id || `idol-${Date.now()}`, 80),
        name: cleanText(idol.name || '無名の練習生', 40),
        personality: cleanText(idol.personality || '', 40),
        age: Number(idol.age) || 18,
        concept: cleanText(idol.concept || '', 80),
        specialty: cleanText(idol.specialty || '', 40),
        profile: cleanText(idol.profile || '', 240),
        catchphrase: cleanText(idol.catchphrase || '', 120),
        stats: normalizeStats(idol.stats || {}),
        fans: Math.max(0, Number(idol.fans) || 0),
        auditions: Math.max(0, Number(idol.auditions) || 0),
        weeks: Math.max(1, Number(idol.weeks) || 1),
        rank: cleanText(idol.rank || '練習生', 40),
        debutReady: Boolean(idol.debutReady),
        debuted: Boolean(idol.debuted),
        fatigue: clampMeter(Number(idol.fatigue) || 0),
        morale: clampMeter(Number(idol.morale) || 50),
        festivalPasses: Math.max(0, Number(idol.festivalPasses) || 0),
        pendingTraining: idol.pendingTraining && typeof idol.pendingTraining === 'object'
            ? idol.pendingTraining
            : null,
        history: Array.isArray(idol.history) ? idol.history.slice(0, 8) : []
    };
}

function normalizeStats(stats) {
    return {
        vocal: clampStat(Number(stats.vocal) || 30),
        dance: clampStat(Number(stats.dance) || 30),
        rap: clampStat(Number(stats.rap) || 30),
        expression: clampStat(Number(stats.expression) || 30),
        stamina: clampStat(Number(stats.stamina) || 30)
    };
}

function getAuditionConfig(type) {
    const configs = {
        local: {
            name: 'ライブハウス公開審査',
            passLine: 58,
            fans: 260,
            fanRate: 3,
            growth: 5,
            fatigue: 12,
            morale: 7,
            weights: { vocal: 1, dance: 1, rap: 0.5, expression: 1.2, stamina: 0.8 }
        },
        media: {
            name: '配信番組オーディション',
            passLine: 68,
            fans: 620,
            fanRate: 5,
            growth: 6,
            fatigue: 16,
            morale: 9,
            weights: { vocal: 1.2, dance: 0.7, rap: 0.7, expression: 1.4, stamina: 0.8 }
        },
        festival: {
            name: '大型フェス選抜',
            passLine: 78,
            fans: 1200,
            fanRate: 8,
            growth: 8,
            fatigue: 22,
            morale: 12,
            weights: { vocal: 1.1, dance: 1.3, rap: 0.9, expression: 1, stamina: 1.2 }
        },
        debut: {
            name: 'デビュー最終審査',
            passLine: 88,
            fans: 2600,
            fanRate: 12,
            growth: 10,
            fatigue: 28,
            morale: 18,
            weights: { vocal: 1.2, dance: 1.2, rap: 1, expression: 1.2, stamina: 1 }
        }
    };

    return configs[type];
}

function calculateGrowth(idol, audition, passed) {
    const base = passed ? audition.growth : Math.max(2, audition.growth - 3);
    const specialtyKey = normalizeSpecialty(idol.specialty);
    return {
        vocal: growthFor('vocal', specialtyKey, base, idol.auditions),
        dance: growthFor('dance', specialtyKey, base, idol.auditions),
        rap: growthFor('rap', specialtyKey, base, idol.auditions),
        expression: growthFor('expression', specialtyKey, base, idol.auditions),
        stamina: Math.max(1, Math.floor(base / 2))
    };
}

function growthFor(stat, specialtyKey, base, auditions) {
    const specialty = specialtyKey === stat ? 3 : 0;
    const rotation = (auditions + stat.length) % 3;
    return Math.max(1, Math.floor(base / 2) + specialty + rotation);
}

function applyGrowth(stats, growth) {
    return {
        vocal: clampStat(stats.vocal + growth.vocal),
        dance: clampStat(stats.dance + growth.dance),
        rap: clampStat(stats.rap + growth.rap),
        expression: clampStat(stats.expression + growth.expression),
        stamina: clampStat(stats.stamina + growth.stamina)
    };
}

function getTrainingConfig(type) {
    const labels = getStatLabels();
    if (type === 'rest') {
        return {
            name: '休養とコンディション調整',
            label: '休養',
            fans: 15,
            fatigue: -32,
            morale: 12
        };
    }
    if (type === 'balanced') {
        return {
            name: '総合リハーサル',
            label: '総合',
            fans: 70,
            fatigue: 14,
            morale: -1
        };
    }

    return {
        name: `${labels[type]}集中レッスン`,
        label: labels[type],
        fans: 45,
        fatigue: 18,
        morale: -3
    };
}

function calculateTrainingGrowth(trainingType, idol) {
    if (trainingType === 'rest') {
        return {
            vocal: 0,
            dance: 0,
            rap: 0,
            expression: 0,
            stamina: 0
        };
    }
    const conditionPenalty = idol.fatigue >= 80 ? -3 : idol.fatigue >= 60 ? -1 : 0;
    const moraleBonus = idol.morale >= 75 ? 1 : idol.morale <= 30 ? -1 : 0;
    if (trainingType === 'balanced') {
        return {
            vocal: Math.max(1, 3 + moraleBonus + conditionPenalty),
            dance: Math.max(1, 3 + moraleBonus + conditionPenalty),
            rap: Math.max(1, 3 + moraleBonus + conditionPenalty),
            expression: Math.max(1, 3 + moraleBonus + conditionPenalty),
            stamina: Math.max(1, 3 + moraleBonus + conditionPenalty)
        };
    }

    const growth = {
        vocal: 1,
        dance: 1,
        rap: 1,
        expression: 1,
        stamina: 1
    };
    const specialtyKey = normalizeSpecialty(idol.specialty);
    growth[trainingType] = Math.max(2, (trainingType === specialtyKey ? 9 : 7) + moraleBonus + conditionPenalty);

    if (trainingType === 'vocal') {
        growth.expression += 2;
    }
    if (trainingType === 'dance') {
        growth.stamina += 2;
    }
    if (trainingType === 'rap') {
        growth.expression += 2;
    }
    if (trainingType === 'expression') {
        growth.vocal += 2;
    }
    if (trainingType === 'stamina') {
        growth.dance += 2;
    }

    return growth;
}

function analyzeImprovement(idol, audition, score, passed, condition) {
    const labels = getStatLabels();
    const lowConditionStat = condition.ready ? null : (idol.fatigue >= 72 ? 'stamina' : 'expression');
    const focusStat = lowConditionStat || Object.entries(audition.weights)
        .map(([stat, weight]) => ({
            stat,
            priority: (100 - idol.stats[stat]) * weight,
            value: idol.stats[stat]
        }))
        .sort((a, b) => b.priority - a.priority)[0].stat;
    const focusLabel = labels[focusStat];
    const gap = Math.max(0, audition.passLine - score);
    const conditionText = condition.ready ? '' : ` ただし${condition.message}`;
    const reason = passed
        ? `合格していますが、次の上位審査では${focusLabel}の完成度が差になります。`
        : `合格ラインまであと${gap}点。今回の審査配点では${focusLabel}が一番伸びしろです。${conditionText}`;

    return {
        focusStat,
        focusLabel,
        reason,
        advice: buildPracticeAdvice(focusStat, passed),
        training: {
            type: focusStat,
            name: `${focusLabel}集中レッスン`,
            expected: `${focusLabel}を大きく伸ばし、関連能力も少し底上げします。`
        }
    };
}

function buildPracticeAdvice(stat, passed) {
    const prefix = passed ? '次の審査に向けて' : '再挑戦の前に';
    const advice = {
        vocal: '音程の安定とサビ前の息継ぎを重点的に確認しましょう。',
        dance: '振りの大きさと移動後の止まり方を揃えましょう。',
        rap: '言葉の粒立ちとリズムの前ノリを練習しましょう。',
        expression: '歌詞に合わせた目線、表情、間の作り方を磨きましょう。',
        stamina: '後半でも声量と動きが落ちない通し練習を増やしましょう。'
    };

    return `${prefix}、${advice[stat]}`;
}

function buildTrainingComment(trainingType, growth) {
    const labels = getStatLabels();
    const strongest = Object.entries(growth).sort((a, b) => b[1] - a[1])[0][0];

    if (trainingType === 'rest') {
        return '休養で疲労を抜き、士気を立て直しました。無理に詰め込むより次の審査の点が安定します。';
    }
    if (trainingType === 'balanced') {
        return '全体リハーサルで基礎をまんべんなく確認しました。次の審査で崩れにくくなります。';
    }

    return `${labels[strongest]}を中心に練習しました。弱点を補強し、審査で見られやすい部分が安定します。`;
}

function weightedScore(stats, weights) {
    const entries = Object.entries(weights);
    const totalWeight = entries.reduce((sum, entry) => sum + entry[1], 0);
    const total = entries.reduce((sum, entry) => sum + stats[entry[0]] * entry[1], 0);
    return total / totalWeight;
}

function averageStat(stats) {
    return Math.round((stats.vocal + stats.dance + stats.rap + stats.expression + stats.stamina) / 5);
}

function minStat(stats) {
    return Math.min(stats.vocal, stats.dance, stats.rap, stats.expression, stats.stamina);
}

function calculateCondition(idol) {
    const fatiguePenalty = idol.fatigue >= 85 ? -16 : idol.fatigue >= 70 ? -10 : idol.fatigue >= 55 ? -5 : 0;
    const moraleModifier = idol.morale >= 80 ? 6 : idol.morale >= 65 ? 3 : idol.morale <= 25 ? -8 : idol.morale <= 40 ? -4 : 0;
    const ready = idol.fatigue < 75 && idol.morale >= 35;
    const message = idol.fatigue >= 75
        ? '疲労が高く、本番で動きが落ちています。'
        : idol.morale < 35
            ? '士気が低く、表情と集中力が不安定です。'
            : 'コンディションは安定しています。';

    return {
        ready,
        scoreModifier: fatiguePenalty + moraleModifier,
        message
    };
}

function isDebutReady(idol) {
    return hasMaxStatAndAverageOthers(idol.stats);
}

function hasMaxStatAndAverageOthers(stats) {
    const values = [stats.vocal, stats.dance, stats.rap, stats.expression, stats.stamina].map(Number);
    const maxIndex = values.findIndex(value => value >= 100);
    if (maxIndex === -1) {
        return false;
    }

    const others = values.filter((value, index) => index !== maxIndex);
    const othersAverage = others.reduce((sum, value) => sum + value, 0) / others.length;
    return othersAverage >= 75;
}

function clampMeter(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}

function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
}

function deterministicSwing(id, auditions, type) {
    const seed = hashText(`${id}-${auditions}-${type}`);
    return (seed % 17) - 6;
}

function decideRank(fans, stats, passed, auditionType) {
    if (auditionType === 'debut' && passed) {
        return 'デビュー決定';
    }
    if (fans >= 5000 && averageStat(stats) >= 80) {
        return 'デビュー候補';
    }
    if (fans >= 2500) {
        return '注目練習生';
    }
    if (fans >= 1000) {
        return '劇場選抜候補';
    }
    return '練習生';
}

function buildProfile(input, stats) {
    const strongest = Object.entries(stats).sort((a, b) => b[1] - a[1])[0][0];
    const labels = {
        vocal: '歌声',
        dance: 'ダンス',
        rap: 'ラップ',
        expression: '表現力',
        stamina: 'スタミナ'
    };

    return `${input.concept}を軸にした${input.age}歳の候補生。${input.personality}な性格で、${labels[strongest]}を武器にファンを増やしていく。`;
}

function buildJudgeComment(idol, audition, score, passed, growth) {
    const bestGrowth = Object.entries(growth).sort((a, b) => b[1] - a[1])[0][0];
    const labels = {
        vocal: '歌',
        dance: 'ダンス',
        rap: 'ラップ',
        expression: '表情と目線',
        stamina: '最後まで落ちない体力'
    };
    const verdict = passed ? '合格です' : '今回は保留です';
    const note = score >= 86
        ? 'デビュー後の姿が具体的に見えました'
        : score >= 72
            ? '個性は十分に届いています'
            : '基礎を積むとコンセプトがもっと伝わります';

    return `${verdict}。${audition.name}では${labels[bestGrowth]}が伸びました。${note}。`;
}

function getStatLabels() {
    return {
        vocal: '歌',
        dance: 'ダンス',
        rap: 'ラップ',
        expression: '表現力',
        stamina: 'スタミナ'
    };
}

function normalizeSpecialty(specialty) {
    if (specialty.includes('歌') || specialty.toLowerCase().includes('vocal')) {
        return 'vocal';
    }
    if (specialty.includes('ダンス') || specialty.toLowerCase().includes('dance')) {
        return 'dance';
    }
    if (specialty.includes('ラップ') || specialty.toLowerCase().includes('rap')) {
        return 'rap';
    }
    if (specialty.includes('表現') || specialty.includes('演技')) {
        return 'expression';
    }
    return 'stamina';
}

function specialtyBonus(specialtyKey, stat) {
    return specialtyKey === stat ? 18 : 0;
}

function personalityBonus(personality, stat) {
    const text = personality.toLowerCase();
    if ((text.includes('明る') || text.includes('元気')) && stat === 'expression') {
        return 8;
    }
    if ((text.includes('努力') || text.includes('真面目')) && stat === 'stamina') {
        return 8;
    }
    if ((text.includes('クール') || text.includes('冷静')) && stat === 'rap') {
        return 7;
    }
    if ((text.includes('繊細') || text.includes('優し')) && stat === 'vocal') {
        return 7;
    }
    return 0;
}

function ageStaminaBonus(age) {
    if (age <= 16) {
        return 6;
    }
    if (age <= 24) {
        return 4;
    }
    return 1;
}

function clampStat(value) {
    return Math.max(1, Math.min(100, Math.round(value)));
}

function hashText(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function seededRandom(seed) {
    let value = seed % 2147483647;
    if (value <= 0) {
        value += 2147483646;
    }
    return function next() {
        value = value * 16807 % 2147483647;
        return (value - 1) / 2147483646;
    };
}

async function callOpenAI(prompt) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is not set');
    }

    const response = await fetch(OPENAI_API_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: MODEL,
            messages: [
                { role: 'system', content: prompt }
            ],
            max_completion_tokens: 2000,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'OpenAI API error');
    }

    const data = await response.json();
    const responseText = data.choices[0].message.content;
    return extractArray(responseText);
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const response = await fetch(`${GEMINI_API_BASE_URL}${MODEL}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                maxOutputTokens: 3000,
                response_mime_type: "application/json"
            }
        })
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Gemini API error');
    }

    const data = await response.json();
    const responseText = data.candidates[0].content.parts[0].text;
    return extractArray(responseText);
}

// LLM が返した JSON 文字列をパースし、最初に見つかった配列を取り出す
function extractArray(responseText) {
    let parsedData;
    try {
        parsedData = JSON.parse(responseText);
    } catch (parseError) {
        throw new Error('Failed to parse LLM response: ' + parseError.message);
    }

    const arrayData = Object.values(parsedData).find(Array.isArray);
    if (!arrayData) {
        throw new Error('No array found in the LLM response object.');
    }
    return arrayData;
}

app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST}:${PORT}`);
    console.log(`Config: ${PROVIDER} - ${MODEL}`);
});
