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
    const allowedTypes = ['vocal', 'dance', 'rap', 'expression', 'stamina', 'balanced'];

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
        pendingTraining: null,
        history: []
    };
}

function runAudition(idol, auditionType) {
    const current = normalizeIdol(idol);
    const audition = getAuditionConfig(auditionType);
    const average = weightedScore(current.stats, audition.weights);
    const experience = Math.min(12, current.auditions * 2);
    const score = Math.round(average + experience + deterministicSwing(current.id, current.auditions, auditionType));
    const passed = auditionType === 'debut'
        ? score >= 86 && current.fans >= 5000 && current.auditions >= 5
        : score >= audition.passLine;
    const growth = calculateGrowth(current, audition, passed);
    const updatedStats = applyGrowth(current.stats, growth);
    const gainedFans = Math.max(20, Math.round((passed ? audition.fans : audition.fans * 0.42) + score * audition.fanRate));
    const nextFans = current.fans + gainedFans;
    const nextAuditions = current.auditions + 1;
    const nextRank = decideRank(nextFans, updatedStats, passed, auditionType);
    const debuted = current.debuted || (auditionType === 'debut' && passed);
    const debutReady = debuted || (nextFans >= 5000 && averageStat(updatedStats) >= 80 && nextAuditions >= 5);
    const improvement = analyzeImprovement(current, audition, score, passed);
    const historyItem = {
        type: 'audition',
        week: current.weeks,
        name: audition.name,
        score,
        passed,
        fans: gainedFans,
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
    const debutReady = nextFans >= 5000 && averageStat(updatedStats) >= 80 && current.auditions >= 5;
    const historyItem = {
        type: 'training',
        week: current.weeks,
        name: training.name,
        growth,
        fans: training.fans,
        comment: buildTrainingComment(trainingType, growth)
    };
    const updatedIdol = {
        ...current,
        stats: updatedStats,
        fans: nextFans,
        weeks: current.weeks + 1,
        rank: decideRank(nextFans, updatedStats, false, 'training'),
        debutReady,
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
            weights: { vocal: 1, dance: 1, rap: 0.5, expression: 1.2, stamina: 0.8 }
        },
        media: {
            name: '配信番組オーディション',
            passLine: 68,
            fans: 620,
            fanRate: 5,
            growth: 6,
            weights: { vocal: 1.2, dance: 0.7, rap: 0.7, expression: 1.4, stamina: 0.8 }
        },
        festival: {
            name: '大型フェス選抜',
            passLine: 78,
            fans: 1200,
            fanRate: 8,
            growth: 8,
            weights: { vocal: 1.1, dance: 1.3, rap: 0.9, expression: 1, stamina: 1.2 }
        },
        debut: {
            name: 'デビュー最終審査',
            passLine: 86,
            fans: 2600,
            fanRate: 12,
            growth: 10,
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
    if (type === 'balanced') {
        return {
            name: '総合リハーサル',
            label: '総合',
            fans: 70
        };
    }

    return {
        name: `${labels[type]}集中レッスン`,
        label: labels[type],
        fans: 45
    };
}

function calculateTrainingGrowth(trainingType, idol) {
    if (trainingType === 'balanced') {
        return {
            vocal: 3,
            dance: 3,
            rap: 3,
            expression: 3,
            stamina: 3
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
    growth[trainingType] = trainingType === specialtyKey ? 9 : 7;

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

function analyzeImprovement(idol, audition, score, passed) {
    const labels = getStatLabels();
    const focusStat = Object.entries(audition.weights)
        .map(([stat, weight]) => ({
            stat,
            priority: (100 - idol.stats[stat]) * weight,
            value: idol.stats[stat]
        }))
        .sort((a, b) => b.priority - a.priority)[0].stat;
    const focusLabel = labels[focusStat];
    const gap = Math.max(0, audition.passLine - score);
    const reason = passed
        ? `合格していますが、次の上位審査では${focusLabel}の完成度が差になります。`
        : `合格ラインまであと${gap}点。今回の審査配点では${focusLabel}が一番伸びしろです。`;

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
