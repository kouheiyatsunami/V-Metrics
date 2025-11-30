1231// --- アプリ全体の初期化と設定 ---
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            let wakeLock = null;
            const request = async () => {
                try {
                    wakeLock = await navigator.wakeLock.request('screen');
                    console.log('Wake Lock is active (画面スリープ防止中)');
                } catch (err) {
                    console.error(`Wake Lock Error: ${err.name}, ${err.message}`);
                }
            };
            
            // 初回リクエスト
            await request();

            // タブ切り替えなどで解除されたら再取得するリスナー
            document.addEventListener('visibilitychange', async () => {
                if (wakeLock !== null && document.visibilityState === 'visible') {
                    await request();
                }
            });
        }
    } catch (err) {
        console.warn("Wake Lock API not supported on this browser");
    }
}
async function initialize() {
    console.log("V-Metrics Initializing...");
    // 1. UI要素の取得
    cacheUIElements();
    await initializeMasterData();
    InputSelectorManager.init();
    // 2. イベントリスナーの設定
    setupEventListeners();
    // 3. 画面スリープ防止の開始
    await requestWakeLock();
    // 4. 画面状態の復元 (既存のグローバル変数を使って描画)
    updateSpikerUIRotation(currentRotation);
    updateInputDisplay();
    updateScoreboardUI();
    const lastMatch = await db.matchInfo.get(currentMatchId);
    if (lastMatch) {
        UIManager.updateCompetitionName(lastMatch.competition_name);
        if (uiElements.oppTeamNameDisplay) {
            uiElements.oppTeamNameDisplay.textContent = lastMatch.opponent_name;
        }
    }
    console.log("V-Metrics Ready.");
}
document.addEventListener('DOMContentLoaded', () => {
    initialize();
});

// --- データベース定義 (変更なし) ---
const db = new Dexie('VMetricsDB');
db.version(3).stores({
    playerList: '&player_id, player_name',
    matchInfo: '++match_id, match_date, opponent_name',
    setRoster: '++set_roster_id, [match_id+set_number], player_id',
    rallyLog: `
        ++play_id, 
        rally_id, 
        match_id, 
        set_number, 
        spiker_id, 
        attack_type, 
        result,
        pass_position,
        toss_area,
        toss_distance,
        toss_length,
        toss_height,
        reason
    `,
    setSummary: '[match_id+set_number]',
    lineupPatterns: '++id, name',
    appConfig: 'key'
});
db.open().catch((err) => {
    console.error('データベースのオープンに失敗しました: ', err);
});

// --- グローバルな試合状態管理 (変更なし) ---
const GameManager = {
    state: {
        matchId: 1,
        setNumber: 1,
        rotation: 1,
        setterId: 'p1',
        rallyId: 1,
        ourScore: 0,
        opponentScore: 0,
        ourSets: 0,
        opponentSets: 0,
        isOurServing: true,
        isSliding: false,
        firstServerOfCurrentSet: null,
    },
    liberoMap: {},
    history: [],
    get current() {
        return this.state;
    },
    saveSnapshot() {
        const snapshot = {
            state: JSON.parse(JSON.stringify(this.state)),
            liberoMap: JSON.parse(JSON.stringify(this.liberoMap))
        };
        this.history.push(snapshot);
        if (this.history.length > 10) this.history.shift();
    },
    undoState() {
        if (this.history.length === 0) {
            UIManager.showFeedback("これ以上戻れません。");
            return false;
        }
        const prev = this.history.pop();
        this.state = prev.state;
        this.liberoMap = prev.liberoMap;
        this.syncGlobals();
        updateSpikerUIRotation(this.state.rotation);
        populateInGameDropdowns();
        return true;
    },
    resetMatch(matchId, startRotation, startSetterId, isOurServe) {
        this.state.matchId = matchId;
        this.state.setNumber = 1;
        this.state.rotation = startRotation || 1;
        this.state.setterId = startSetterId;
        this.state.rallyId = 1;
        this.state.ourScore = 0;
        this.state.opponentScore = 0;
        this.state.isOurServing = isOurServe;
        this.state.ourSets = 0;
        this.state.opponentSets = 0;
        this.state.firstServerOfCurrentSet = isOurServe ? 'our' : 'opp';
        this.syncGlobals(); // グローバル変数にも反映
    },
    addScore(isOurPoint) {
        this.saveSnapshot(); // 履歴保存
        if (isOurPoint) {
            this.state.ourScore++;
            if (!this.state.isOurServing) {
                this.rotate(); 
            }
            this.state.isOurServing = true;
        } else {
            this.state.opponentScore++;
            this.state.isOurServing = false;
        }
        this.state.rallyId++;
        this.syncGlobals();
        UIManager.updateScoreboard(); // 得点板更新
    },
    rotate() {
        this.state.rotation = (this.state.rotation % 6) + 1;
        console.log(`Rotated to: ${this.state.rotation}`);
        this.checkLiberoRotation();
        this.syncGlobals(); 
        updateSpikerUIRotation(this.state.rotation);
    },
    checkLiberoRotation() {
        const rotation = this.state.rotation;
        const originalPlayerIds = Object.keys(this.liberoMap);
        if (originalPlayerIds.length === 0) return;
        originalPlayerIds.forEach(originalId => {
            const rosterItem = testRoster.find(r => r.playerId === originalId);
            if (!rosterItem) {
                console.warn(`Roster data not found for ${originalId}`);
                return;
            }
            let currentPos = (rosterItem.position - rotation + 1);
            if (currentPos <= 0) currentPos += 6;
            if ([2, 3, 4].includes(currentPos)) {
                const liberoId = this.liberoMap[originalId];
                const libName = testPlayerList[liberoId]?.name || 'リベロ';
                const orgName = testPlayerList[originalId]?.name || '元選手';
                console.log(`Auto OUT Triggered for ${libName}`);
                UIManager.showFeedback(`前衛にローテしたため、\n${libName} と ${orgName} を交代しました。`);
                this.executeLiberoSwap(liberoId, originalId, false); // false = OUT処理
            }
        });
    },
    executeLiberoSwap(liberoId, originalId, isEntering) {
        if (isEntering) {
            this.liberoMap[originalId] = liberoId;
            this.updatePlayerStatus(originalId, null); // 元選手はベンチへ
            this.updatePlayerStatus(liberoId, 'LB');   // リベロはコートへ
        } else {
            delete this.liberoMap[originalId];
            this.updatePlayerStatus(liberoId, null); // リベロはベンチへ
            const originalRole = testPlayerList[originalId]?.position || 'MB';
            this.updatePlayerStatus(originalId, originalRole); // 元選手復帰
        }
        updateSpikerUIRotation(this.state.rotation);
        populateInGameDropdowns();
    },
    async restoreMatchState(matchId) {
        const summaries = await db.setSummary.where('match_id').equals(matchId).toArray();
        let w = 0;
        let l = 0;
        let maxSet = 0;
        summaries.forEach(s => {
            if (s.set_result === 'W') w++;
            if (s.set_result === 'L') l++;
            if (s.set_number > maxSet) maxSet = s.set_number;
        });
        this.state.ourSets = w;
        this.state.opponentSets = l;
        this.state.setNumber = maxSet + 1; // 次のセット
        const lastLog = await db.rallyLog.where('match_id').equals(matchId).last();
        if (lastLog) {
            this.state.rallyId = lastLog.rally_id + 1;
        } else {
            this.state.rallyId = 1;
        }
        this.state.ourScore = 0;
        this.state.opponentScore = 0;
        console.log(`試合復元: ID=${matchId}, 次は第${this.state.setNumber}セット, SetCount=[${w}-${l}], RallyID=${this.state.rallyId}`);
        this.syncGlobals();
    },
    syncGlobals() {
        currentMatchId = this.state.matchId;
        currentSetNumber = this.state.setNumber;
        currentRotation = this.state.rotation;
        currentSetterId = this.state.setterId;
        currentRallyId = this.state.rallyId;
        ourScore = this.state.ourScore;
        opponentScore = this.state.opponentScore;
        isOurTeamServing = this.state.isOurServing;
        isSlidingFromCourt = this.state.isSliding;
    },
    updatePlayerStatus(playerId, status) {
        if (testPlayerList[playerId]) {
            testPlayerList[playerId].active_position = status;
        }
    },
    getPlayersOnCourt() {
        const players = [];
        testRoster.forEach(starter => {
            const originalId = starter.playerId;
            if (this.liberoMap[originalId]) {
                const liberoId = this.liberoMap[originalId];
                if (testPlayerList[liberoId]) players.push(testPlayerList[liberoId]);
            } else {
                if (testPlayerList[originalId]) players.push(testPlayerList[originalId]);
            }
        });
        return players;
    },
    getCurrentSetter() {
        const setter = Object.values(testPlayerList).find(p => p.active_position === 'S');
        return setter || testPlayerList[this.state.setterId];
    },
    getCurrentLiberos() {
        return Object.values(testPlayerList).filter(p => p.active_position === 'LB');
    },
    calcPointDelta(record) {
        const result = record.result;
        const attackType = record.attack_type;
        if (result === 'KILL') return 1;
        if (attackType === 'SERVE_ACE') return 1;
        if (attackType === 'OPPONENT_MISS') return 1;
        if (attackType === 'FOUL' && result === 'KILL') return 1;
        if (result === 'FAULT') return -1;
        if (result === 'BLOCKED') return -1;
        if (attackType === 'SERVE_MISS') return -1;
        if (attackType === 'FOUL' && result === 'FAULT') return -1;
        return 0; // ラリー継続など
    },
    applyScoreCorrection(oldRecord, newRecord) {
        const oldPoint = oldRecord ? this.calcPointDelta(oldRecord) : 0;
        const newPoint = newRecord ? this.calcPointDelta(newRecord) : 0;
        if (oldPoint === 1) this.state.ourScore--; // 旧記録が自得点なら減らす
        if (newPoint === 1) this.state.ourScore++; // 新記録が自得点なら増やす
        if (oldPoint === -1) this.state.opponentScore--; // 旧記録が相手得点なら減らす(-1点だったのを戻す)
        if (newPoint === -1) this.state.opponentScore++; // 新記録が相手得点なら増やす
        this.syncGlobals();
        UIManager.updateScoreboard();
    },
    checkSetEndCondition() {
        const s1 = this.state.ourScore;
        const s2 = this.state.opponentScore;
        const limit = (this.state.setNumber === 5) ? 15 : 25; // 5セット目は15点
        if ((s1 >= limit || s2 >= limit) && Math.abs(s1 - s2) >= 2) {
            return true;
        }
        return false;
    },
    async finishSet() {
        const s1 = this.state.ourScore;
        const s2 = this.state.opponentScore;
        let resultChar = null; // "W" or "L"
        if (s1 > s2) {
            resultChar = "W";
            this.state.ourSets++;
        } else {
            resultChar = "L";
            this.state.opponentSets++;
        }
        try {
            await db.setSummary
                .where('[match_id+set_number]')
                .equals([this.state.matchId, this.state.setNumber])
                .modify({
                    our_final_score: s1,
                    opponent_final_score: s2,
                    set_result: resultChar
                });
            return { ourScore: s1, oppScore: s2, setNum: this.state.setNumber };
        } catch (e) {
            UIManager.showFeedback("セット結果の保存に失敗しました");
            return null;
        }
    },
    async proceedToNextSet() {
        this.state.setNumber++;
        this.state.ourScore = 0;
        this.state.opponentScore = 0;
        await db.setSummary.put({
            match_id: this.state.matchId,
            set_number: this.state.setNumber,
            our_final_score: 0,
            opponent_final_score: 0,
            set_result: null
        });
        this.syncGlobals();
        UIManager.updateScoreboard();
    },
    async updateScoreManual(isOur, delta) {
        if (isOur) {
            this.state.ourScore = Math.max(0, this.state.ourScore + delta);
        } else {
            this.state.opponentScore = Math.max(0, this.state.opponentScore + delta);
        }
        this.syncGlobals();
        UIManager.updateScoreboard();
        try {
            await db.setSummary
                .where('[match_id+set_number]')
                .equals([this.state.matchId, this.state.setNumber])
                .modify({
                    our_final_score: this.state.ourScore,
                    opponent_final_score: this.state.opponentScore
                });
            console.log("スコア手動更新保存完了");
        } catch (e) {
            console.error("スコア保存失敗", e);
        }
    },
    isBackRowPlayer(playerId) {
        if (this.liberoMap[playerId]) return true; // その選手IDの代わりにリベロが出ている
        const activeLiberos = Object.values(this.liberoMap);
        if (activeLiberos.includes(playerId)) return true; // その選手自体がリベロ
        const rosterItem = testRoster.find(r => r.playerId === playerId);
        if (!rosterItem) return false;
        const currentRotation = this.state.rotation;
        let currentVisualPos = (rosterItem.position - currentRotation + 1);
        if (currentVisualPos <= 0) currentVisualPos += 6;
        return [1, 6, 5].includes(currentVisualPos);
    },
    validateAttackRules(entry) {
        if (!entry.spiker_id || !entry.attack_type) return true; // 未入力はスルー
        const isBackRow = this.isBackRowPlayer(entry.spiker_id);
        const frontAttacks = ['A_QUICK', 'B_QUICK', 'C_QUICK', 'A_SEMI', 'B_SEMI', 'C_SEMI'];
        const frontAreas = ['A', 'B', 'C'];
        // 条件: 「後衛選手」かつ「前衛攻撃 または トスエリアがA/B/C」
        if (isBackRow) {
            const isFrontType = frontAttacks.includes(entry.attack_type);
            const isFrontArea = frontAreas.includes(entry.toss_area);
            if (isFrontType || isFrontArea) {
                if (entry.attack_type !== 'BACK_ATTACK') {
                    return false; // 違反
                }
            }
        }
        return true; // OK
    },
    async handleManualScore(isOurPoint) {
        // 1. 理由コードの決定
        const reasonCode = isOurPoint ? 'OP' : 'EH';
        // 2. 簡易記録データの作成
        const record = {
            match_id: this.state.matchId,
            set_number: this.state.setNumber,
            rally_id: this.state.rallyId,
            rotation_number: this.state.rotation,
            setter_id: this.state.setterId, // その時のセッターIDは記録
            spiker_id: null, // 選手は特定しない
            attack_type: 'MANUAL', // 手動入力マーカー
            result: isOurPoint ? 'OPP_MISS' : 'FAULT', // 結果分類
            reason: reasonCode, // ★ここで理由を保存

            pass_position: null,
            toss_area: null,
            toss_distance: null,
            toss_length: null,
            toss_height: null
        };
        try {
            await db.rallyLog.add(record);
            console.log(`手動得点記録: ${reasonCode}`);
            this.addScore(isOurPoint);
        } catch (e) {
            console.error("手動記録エラー", e);
            UIManager.showFeedback("記録に失敗しました");
        }
    },
};

let currentMatchId = GameManager.state.matchId;
let currentSetNumber = GameManager.state.setNumber;
let currentRotation = GameManager.state.rotation;
let currentSetterId = GameManager.state.setterId;
let currentRallyId = GameManager.state.rallyId;
let ourScore = GameManager.state.ourScore;
let opponentScore = GameManager.state.opponentScore;
let isOurTeamServing = GameManager.state.isOurServing;
let isSlidingFromCourt = GameManager.state.isSliding;

let liberoPairs = [];
let tempStarters = {};
let allPlayersCache = [];
let currentEditingPos = null;
let testPlayerList = {};
let testLiberos = {};
let testRoster = [];

const defaultRallyEntry = {
    match_id: currentMatchId,
    set_number: currentSetNumber, // これでエラーが消えます
    rally_id: null,
    rotation_number: currentRotation,
    setter_id: currentSetterId,
    pass_position: 'UNKNOWN',
    toss_area: 'UNKNOWN',
    spiker_id: null,
    result: null,
    attack_type: null,
    toss_distance: 'good',
    toss_length: 'good',
    toss_height: 'good',
};
let currentRallyEntry = { ...defaultRallyEntry };
let uiElements = {};

// --- UI描画管理 (UIManager) ---
const UIManager = {
    // 画面切り替え
    switchScreen(screenName) {
        uiElements.homeScreen.style.display = 'none';
        uiElements.recordScreen.style.display = 'none';
        uiElements.playersScreen.style.display = 'none';
        switch (screenName) {
            case 'home': uiElements.homeScreen.style.display = 'flex'; break;
            case 'record': uiElements.recordScreen.style.display = 'flex'; break;
            case 'players': uiElements.playersScreen.style.display = 'flex'; break;
        }
    },
    // フィードバック用要素とタイマー
    feedbackEl: document.getElementById('feedback-message'),
    feedbackTimer: null,
    // フィードバック表示関数
    showFeedback(message) {
        if (!this.feedbackEl) this.feedbackEl = document.getElementById('feedback-message');
        if (this.feedbackTimer) clearTimeout(this.feedbackTimer);
        this.feedbackEl.textContent = message;
        this.feedbackEl.classList.add('show');
        this.feedbackTimer = setTimeout(() => {
            this.feedbackEl.classList.remove('show');
        }, 2000); // ★1秒だと読む前に消えることがあるので、2秒(2000)推奨です
    },
    // 入力フォーム（プルダウン、ボタンの色など）の一括更新
    updateInputForm() {
        // プルダウンの値セット
        uiElements.selectSetter.value = currentRallyEntry.setter_id || "";
        uiElements.selectPassPos.value = currentRallyEntry.pass_position || "UNKNOWN";
        uiElements.selectTossArea.value = currentRallyEntry.toss_area || "UNKNOWN";
        uiElements.selectSpiker.value = currentRallyEntry.spiker_id || "";
        uiElements.selectAttackType.value = currentRallyEntry.attack_type || "";
        uiElements.selectResult.value = currentRallyEntry.result || "";
        // 変更があった項目のハイライト処理
        const highlight = (el, val, def) => el.classList.toggle('changed', (val || "") !== (def || ""));
        highlight(uiElements.selectSetter, currentRallyEntry.setter_id, currentSetterId);
        highlight(uiElements.selectPassPos, currentRallyEntry.pass_position, "UNKNOWN");
        highlight(uiElements.selectTossArea, currentRallyEntry.toss_area, "UNKNOWN");
        highlight(uiElements.selectSpiker, currentRallyEntry.spiker_id, null);
        highlight(uiElements.selectAttackType, currentRallyEntry.attack_type, null);
        highlight(uiElements.selectResult, currentRallyEntry.result, null);
        // トス品質ボタンのActive状態切替
        const toggle = (el, prop, val) => el.classList.toggle('active', currentRallyEntry[prop] === val);
        toggle(uiElements.tossFar, 'toss_distance', 'far');
        toggle(uiElements.tossNear, 'toss_distance', 'near');
        toggle(uiElements.tossLong, 'toss_length', 'long');
        toggle(uiElements.tossShort, 'toss_length', 'short');
        toggle(uiElements.tossHigh, 'toss_height', 'high');
        toggle(uiElements.tossLow, 'toss_height', 'low');
        // ミスボタン、特殊攻撃ボタンの状態
        const isMiss = currentRallyEntry.toss_distance === 'miss';
        uiElements.btnMiss.classList.toggle('active', isMiss);
        uiElements.btnDirect.classList.toggle('active', currentRallyEntry.attack_type === 'DIRECT');
        uiElements.btnTwoAttack.classList.toggle('active', currentRallyEntry.attack_type === 'TWO_ATTACK');
    },
    // スコアボードとサーブ権の更新（2つの関数を統合）
    updateCompetitionName(name) {
        const el = document.getElementById('scoreboard-competition-name');
        if (el) el.textContent = name || '';
    },
    updateScoreboard() {
        // 点数表示
        if (uiElements.ourScoreDisplay) uiElements.ourScoreDisplay.textContent = ourScore;
        if (uiElements.oppScoreDisplay) uiElements.oppScoreDisplay.textContent = opponentScore;
        // サーブ権アイコン表示
        if (isOurTeamServing) {
            uiElements.ourServeIcon.style.visibility = 'visible';
            uiElements.opponentServeIcon.style.visibility = 'hidden';
        } else {
            uiElements.ourServeIcon.style.visibility = 'hidden';
            uiElements.opponentServeIcon.style.visibility = 'visible';
        }
        if (uiElements.ourSetDisplay) {
            uiElements.ourSetDisplay.textContent = `[ ${GameManager.state.ourSets} ]`;
        }
        if (uiElements.oppSetDisplay) {
            uiElements.oppSetDisplay.textContent = `[ ${GameManager.state.opponentSets} ]`;
        }
        if (uiElements.btnSetEnd) {
            const canEnd = GameManager.checkSetEndCondition();
            if (canEnd) {
                uiElements.btnSetEnd.classList.add('ready-to-end');
                uiElements.btnSetEnd.disabled = false; // 押せるように
                uiElements.btnSetEnd.textContent = "セット終了！";
            } else {
                uiElements.btnSetEnd.classList.remove('ready-to-end');
                uiElements.btnSetEnd.disabled = true; // 押せないように(ロックする場合)
                uiElements.btnSetEnd.textContent = "セット終了";
            }
        }
    },
    // リベロ交代のUI
    updateCourtRotation(rotation) {
        const activeLiberoIds = Object.values(GameManager.liberoMap);
        const isLiberoIn = activeLiberoIds.length > 0;
        // リベロボタンの見た目更新
        if (isLiberoIn) {
            uiElements.btnLibero.classList.add('libero-in');
            uiElements.btnLibero.textContent = 'リベロ OUT';
        } else {
            uiElements.btnLibero.classList.remove('libero-in');
            uiElements.btnLibero.textContent = 'リベロ IN';
        }
        const selectedSpikerId = currentRallyEntry.spiker_id;
        const selectedSetterId = currentRallyEntry.setter_id;
        // グリッド（コート上の6箇所）の描画
        testRoster.forEach(starter => {
            let visualPos = (starter.position - rotation + 1);
            if (visualPos <= 0) visualPos += 6;
            const originalPlayerId = starter.playerId;
            let displayPlayerId = originalPlayerId;
            // ★修正: このポジションの選手がリベロと交代中かチェック
            if (GameManager.liberoMap[originalPlayerId]) {
                displayPlayerId = GameManager.liberoMap[originalPlayerId]; // リベロのIDを表示
            }
            const playerInfo = testPlayerList[displayPlayerId];
            // DOM書き換え
            const gridEl = uiElements.spikerGridPositions[visualPos];
            if (gridEl && playerInfo) {
                gridEl.innerHTML = `
                    <span class="jersey">${playerInfo.jersey}</span>
                    <span class="name">${playerInfo.name}</span>
                `;
                gridEl.dataset.playerId = playerInfo.id;
                if (playerInfo.position === 'LB' || playerInfo.active_position === 'LB') {
                    gridEl.classList.add('libero-active');
                } else {
                    gridEl.classList.remove('libero-active');
                }
                gridEl.style.borderColor = '';
                gridEl.style.borderWidth = '';
                gridEl.style.backgroundColor = ''; 
                gridEl.classList.remove('libero-active', 'spiker-active', 'setter-active');
                if (playerInfo.id === selectedSetterId) {
                    gridEl.classList.add('setter-active');
                }
                else if (playerInfo.id === selectedSpikerId) {
                    gridEl.classList.add('spiker-active');
                }
                else if (playerInfo.position === 'LB' || playerInfo.active_position === 'LB') {
                    gridEl.classList.add('libero-active');
                }
            }
        });
    }
};
const EditManager = {
    async openLogModal() {
        const logContainer = document.getElementById('log-list-container');
        if (!logContainer) return; // エラーガード
        logContainer.innerHTML = ''; // クリア
        try {
            const records = await db.rallyLog
                .where('match_id')
                .equals(currentMatchId)
                .filter(record => record.set_number === currentSetNumber)
                .reverse()
                .toArray();
            if (records.length === 0) {
                logContainer.innerHTML = '<p style="padding:20px; text-align:center; color:#666;">記録がありません</p>';
                document.getElementById('log-modal').style.display = 'flex';
                return;
            }
            records.forEach(record => {
                const wrapper = document.createElement('div');
                wrapper.className = 'log-item-wrapper';
                const spikerId = record.spiker_id;
                let player = { name: '不明', jersey: '?' };
                if (spikerId && testPlayerList[spikerId]) {
                    player = testPlayerList[spikerId];
                }
                const actionName = this.getActionName(record);
                wrapper.innerHTML = `
                    <div class="log-item-actions">
                        <button class="btn-log-edit" onclick="EditManager.editRecord(${record.play_id})">修正</button>
                        <button class="btn-log-delete" onclick="EditManager.deleteRecord(${record.play_id})">削除</button>
                    </div>
                    <div class="log-item-content" ontouchstart="EditManager.handleTouchStart(event, this)" ontouchend="EditManager.handleTouchEnd(event, this)">
                        <div>
                            <span style="font-weight:bold; color:#333;">${currentSetNumber}セット - No.${record.rally_id}</span><br>
                            <span style="font-size:0.9em; color:#666;">
                                [${player.jersey}] ${player.name} : ${actionName} 
                                <span style="font-weight:bold; color:var(--navy); margin-left:5px;">[${record.reason || '-'}]</span>
                            </span>
                        </div>
                        <div style="font-weight:bold; font-size:1.2em;">${this.getResultSymbol(record)}</div>
                    </div>
                `;
                logContainer.appendChild(wrapper);
            });
            document.getElementById('log-modal').style.display = 'flex';
        } catch (err) {
            console.error("ログ取得エラー:", err);
        }
    },
    closeLogModal() {
        document.getElementById('log-modal').style.display = 'none';
    },
    async editRecord(playId) {
        const record = await db.rallyLog.get(playId);
        if (!record) return;
        currentRallyEntry = { ...record };
        UIManager.updateInputForm(); // 画面反映
        this.closeLogModal();
        if (uiElements.btnAdd) {
            uiElements.btnAdd.innerHTML = '修&nbsp;正';
            uiElements.btnAdd.style.backgroundColor = 'var(--navy)';
        }
        UIManager.showFeedback(`No.${record.rally_id} の修正モードになりました。\n内容を変更して「登録」を押してください。`);
    },
    async deleteRecord(playId) {
        if (!confirm('この記録を削除しますか？\nスコアも自動的に補正されます。')) return;
        const record = await db.rallyLog.get(playId);
        if (record) {
            GameManager.applyScoreCorrection(record, null);
            
            await db.rallyLog.delete(playId);
            this.openLogModal(); // リスト再描画
        }
    },
    getActionName(r) {
        if (r.attack_type === 'SPIKE') return 'スパイク';
        if (r.attack_type === 'BLOCK') return 'ブロック';
        if (r.attack_type === 'SERVE') return 'サーブ';
        if (r.attack_type === 'SERVE_ACE') return 'サービスエース';
        if (r.attack_type === 'SERVE_MISS') return 'サーブミス';
        return r.attack_type || 'プレイ';
    },
    getResultSymbol(r) {
        const pt = GameManager.calcPointDelta(r);
        if (pt === 1) return '<span style="color:blue;">+1</span>';
        if (pt === -1) return '<span style="color:red;">Opp+1</span>';
        return '<span style="color:gray;">0</span>';
    },
    startX: 0,
    handleTouchStart(e, element) {
        this.startX = e.touches[0].clientX;
    },
    handleTouchEnd(e, element) {
        const endX = e.changedTouches[0].clientX;
        const diff = this.startX - endX;
        const wrapper = element.parentElement;
        if (diff > 100) {
            document.querySelectorAll('.log-item-wrapper.swiped').forEach(el => el.classList.remove('swiped'));
            wrapper.classList.add('swiped');
        } 
        else if (diff < -50) {
            wrapper.classList.remove('swiped');
        }
    }
};
// --- 分析機能統合 AnalysisManager ---
const AnalysisManager = {
    dom: {},
    state: {
        allRawData: [],
        totalData: [],
        winData: [],
        loseData: [],
        winSetCount: 1,
        loseSetCount: 1,
        totalSetCount: 1,
        allPlayersSet: new Set(),
        allSettersSet: new Set(),
        overallStats: { total: {}, win: {}, lose: {} },
        selectedShareOptions: [] 
    },
    async init() {
        this.cacheDOM();
        this.setupEventListeners();
        await this.initFilters();
    },
    cacheDOM() {
        const d = document;
        this.dom = {
            navItems: d.querySelectorAll('.tab-btn'),
            contentItems: d.querySelectorAll('.analysis-content'),
            categorySelect: d.getElementById('analysis-category-select'),
            opponentSelect: d.getElementById('analysis-opponent-select'),
            btnCalc: d.getElementById('btn-calc-stats'),
            btnBack: d.getElementById('btn-analysis-back'),
            // Overall
            overallAnalysis: d.getElementById('overall-analysis'),
            subTabs: d.querySelectorAll('.sub-tab-btn'),
            overallStatsGrid: d.getElementById('overall-stats-grid'),
            overallGraphContainer: d.getElementById('overall-graphs'),
            overallDisplay: {
                TS: d.getElementById('stat_TS'), TK: d.getElementById('stat_TK'),
                AS: d.getElementById('stat_AS'), AK: d.getElementById('stat_AK'),
                AC: d.getElementById('stat_AC'), AA: d.getElementById('stat_AA'),
                PK: d.getElementById('stat_PK'), PE: d.getElementById('stat_PE'),
                PCA: d.getElementById('stat_PCA'), PF: d.getElementById('stat_PF'),
            },
            overallBars: {
                PK_total: d.getElementById('bar_PK_total'), PK_win: d.getElementById('bar_PK_win'), PK_lose: d.getElementById('bar_PK_lose'),
                PE_total: d.getElementById('bar_PE_total'), PE_win: d.getElementById('bar_PE_win'), PE_lose: d.getElementById('bar_PE_lose'),
                PCA_total: d.getElementById('bar_PCA_total'), PCA_win: d.getElementById('bar_PCA_win'), PCA_lose: d.getElementById('bar_PCA_lose'),
                PF_total: d.getElementById('bar_PF_total'), PF_win: d.getElementById('bar_PF_win'), PF_lose: d.getElementById('bar_PF_lose'),
            },
            // Spiker
            playerFilter: d.getElementById('playerFilter'),
            setFilter: d.getElementById('setFilter'),
            spikerTab1: d.getElementById('spikerTab1'),
            spikerTab2: d.getElementById('spikerTab2'),
            spikerTableView: d.getElementById('spiker-table-view'),
            spikerTableView2: d.getElementById('spiker-table-view-2'),
            spikerGraphView: d.getElementById('spiker-graph-view'),
            spikerTossGraphView: d.getElementById('spiker-toss-graph-view'),
            spikerTableBody: d.querySelector("#spiker-table-view table tbody"),
            spikerTossTableBody: d.querySelector("#spiker-table-view-2 table tbody"),
            spikerGraphDisplay: {
                TS: d.getElementById('stat_TS_spiker'), TK: d.getElementById('stat_TK_spiker'), TF: d.getElementById('stat_TF_spiker'),
                PK: d.getElementById('stat_PK_spiker'), PE: d.getElementById('stat_PE_spiker'), PKE: d.getElementById('stat_PKE_spiker'),
                PF: d.getElementById('stat_PF_spiker'), PC: d.getElementById('stat_PC_spiker'), PA: d.getElementById('stat_PA_spiker'),
                PCA: d.getElementById('stat_PCA_spiker'), PKH: d.getElementById('stat_PKH_spiker'), PB: d.getElementById('stat_PB_spiker'), P2: d.getElementById('stat_P2_spiker'),
            },
            // Setter
            setterPlayerFilter: d.getElementById('setterPlayerFilter'),
            setterSetFilter: d.getElementById('setterSetFilter'),
            setterCutFilter: d.getElementById('setterCutFilter'),
            setterTableBody: d.querySelector("#setter-table-view table tbody"),
            setterPieChart1: d.getElementById('setterPieChart1'),
            setterPieChart2: d.getElementById('setterPieChart2'),
            setterPieLegend1: d.getElementById('setterPieLegend1'),
            setterPieLegend2: d.getElementById('setterPieLegend2'),
            setterTop5List: d.getElementById('setterTop5List'),
            setterTop5Header: d.querySelector("#setter-top5-combinations h3"),
        };
    },
    // --- イベントリスナー設定 ---
    setupEventListeners() {
        if (this.dom.btnBack) this.dom.btnBack.addEventListener('click', () => switchScreen('home'));
        if (this.dom.btnCalc) this.dom.btnCalc.addEventListener('click', () => this.loadAndCalculate());
        this.dom.navItems.forEach(item => {
            item.addEventListener('click', () => {
                const view = item.dataset.view;
                if (!view) return;
                this.dom.navItems.forEach(n => {
                    if(n.parentElement.classList.contains('analysis-tabs')) n.classList.remove('selected');
                });
                if(item.parentElement.classList.contains('analysis-tabs')) item.classList.add('selected');
                this.dom.contentItems.forEach(c => c.classList.remove('active'));
                const contentId = (view === 'pass') ? 'pass-analysis' : `${view}-analysis`;
                const activeContent = document.getElementById(`${view}-analysis`);
                if (activeContent) activeContent.classList.add('active');
                if (view === 'spiker') this.onSpikerFilterChange();
                if (view === 'setter') this.onSetterFilterChange();
            });
        });
        this.dom.subTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const filter = tab.dataset.filter;
                this.dom.subTabs.forEach(t => t.classList.remove('selected'));
                tab.classList.add('selected');
                if (this.dom.overallAnalysis) this.dom.overallAnalysis.className = 'analysis-content active viewing-' + filter;
                if (this.dom.overallGraphContainer) this.dom.overallGraphContainer.className = 'chart-section viewing-' + filter;
                if (filter === 'total') this.updateOverallDisplay(this.state.overallStats.total);
                else if (filter === 'win') this.updateOverallDisplay(this.state.overallStats.win);
                else if (filter === 'lose') this.updateOverallDisplay(this.state.overallStats.lose);
                this.triggerGraphAnimation(this.state.overallStats.total, this.state.overallStats.win, this.state.overallStats.lose);
            });
        });
        if (this.dom.playerFilter) this.dom.playerFilter.addEventListener('change', () => this.onSpikerFilterChange());
        if (this.dom.setFilter) this.dom.setFilter.addEventListener('change', () => this.onSpikerFilterChange());
        if (this.dom.spikerTab1) this.dom.spikerTab1.addEventListener('click', (e) => this.onSpikerTabChange(e));
        if (this.dom.spikerTab2) this.dom.spikerTab2.addEventListener('click', (e) => this.onSpikerTabChange(e));
        if (this.dom.setterPlayerFilter) this.dom.setterPlayerFilter.addEventListener('change', () => this.onSetterFilterChange());
        if (this.dom.setterSetFilter) this.dom.setterSetFilter.addEventListener('change', () => this.onSetterFilterChange());
        if (this.dom.setterCutFilter) this.dom.setterCutFilter.addEventListener('change', () => this.onSetterFilterChange());
    },
    async initFilters() {
        const matches = await db.matchInfo.orderBy('match_date').reverse().toArray(); // 新しい順
        const tournamentGroups = this.groupTournaments(matches);
        this.state.tournamentGroups = tournamentGroups; // ステートに保存
        const catSelect = this.dom.categorySelect;
        catSelect.innerHTML = '';
        const fixedOptions = [
            { val: 'all', text: '全データ' },
            { val: 'official_practice', text: '公式戦・練習試合通算' },
            { val: 'official', text: '公式戦通算' }
        ];
        fixedOptions.forEach(opt => {
            const el = document.createElement('option');
            el.value = opt.val;
            el.textContent = opt.text;
            catSelect.appendChild(el);
        });
        if (tournamentGroups.length > 0) {
            const groupOptgroup = document.createElement('optgroup');
            groupOptgroup.label = "大会別";
            tournamentGroups.forEach(group => {
                const el = document.createElement('option');
                el.value = `group_${group.id}`; // 識別用プレフィックス
                el.textContent = group.displayName;
                groupOptgroup.appendChild(el);
            });
            catSelect.appendChild(groupOptgroup);
        }
        const oppSelect = this.dom.opponentSelect;
        oppSelect.innerHTML = '<option value="all">対戦校 (全員)</option>';
        const opponents = [...new Set(matches.map(m => m.opponent_name))].sort();
        opponents.forEach(opp => {
            const el = document.createElement('option');
            el.value = opp;
            el.textContent = opp;
            oppSelect.appendChild(el);
        });
    },
    groupTournaments(matches) {
        const sorted = [...matches].sort((a, b) => new Date(a.match_date) - new Date(b.match_date));
        const groups = [];
        sorted.forEach(match => {
            const mDate = new Date(match.match_date);
            const groupIndex = groups.findIndex(g => {
                if (g.name !== match.competition_name) return false;
                const lastDate = new Date(g.lastDate);
                const diffTime = Math.abs(mDate - lastDate);
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                return diffDays <= 32; // 余裕を見て32日以内なら同じ大会とみなす
            });
            if (groupIndex !== -1) {
                groups[groupIndex].matchIds.push(match.match_id);
                groups[groupIndex].lastDate = match.match_date; // 最終日を更新
            } else {
                const y = mDate.getFullYear();
                const m = String(mDate.getMonth() + 1).padStart(2, '0');
                groups.push({
                    id: groups.length, // 簡易ID
                    name: match.competition_name,
                    displayName: `${match.competition_name} ${y}-${m}`,
                    startDate: match.match_date,
                    lastDate: match.match_date,
                    matchIds: [match.match_id]
                });
            }
        });
        return groups.reverse();
    },
    async loadAndCalculate() {
        const catVal = this.dom.categorySelect.value;
        const oppVal = this.dom.opponentSelect.value;
        let targetMatchIds = [];
        const allMatches = await db.matchInfo.toArray();
        if (catVal.startsWith('group_')) {
            const groupId = Number(catVal.split('_')[1]);
            const group = this.state.tournamentGroups.find(g => g.id === groupId);
            if (group) targetMatchIds = group.matchIds;
        } else {
            let filteredMatches = allMatches; 
            if (catVal === 'official') {
                filteredMatches = allMatches.filter(m => m.match_type === 'official' || m.match_type === '公式戦');
            } else if (catVal === 'official_practice') {
                filteredMatches = allMatches.filter(m => 
                    ['official', 'practice', '公式戦', '練習試合'].includes(m.match_type)
                );
            } 
            targetMatchIds = filteredMatches.map(m => m.match_id);
        }
        if (oppVal !== 'all') {
            const matchIdSet = new Set(targetMatchIds);
            targetMatchIds = allMatches
                .filter(m => matchIdSet.has(m.match_id) && m.opponent_name === oppVal)
                .map(m => m.match_id);
        }
        if (targetMatchIds.length === 0) {
            UIManager.showFeedback("該当する試合データがありません。");
            return;
        }
        const rallyLogs = await db.rallyLog.where('match_id').anyOf(targetMatchIds).toArray();
        const summaries = await db.setSummary.where('match_id').anyOf(targetMatchIds).toArray();
        const allPlayers = await db.playerList.toArray();
        const playerMap = {};
        allPlayers.forEach(p => playerMap[p.player_id] = p);
        this.state.allRawData = rallyLogs.map(log => {
            const summary = summaries.find(s => s.match_id === log.match_id && s.set_number === log.set_number);
            const setResult = summary ? summary.set_result : null;
            const spikerName = playerMap[log.spiker_id] ? playerMap[log.spiker_id].player_name : (log.spiker_id || 'none');
            const setterName = playerMap[log.setter_id] ? playerMap[log.setter_id].player_name : (log.setter_id || 'none');
            return {
                result: log.result ? log.result.toLowerCase() : '', 
                pass: log.pass_position || '',
                set_distance: (log.toss_distance || '').toLowerCase(),
                set_length:   (log.toss_length || '').toLowerCase(),
                set_height:   (log.toss_height || '').toLowerCase(),
                player: spikerName,
                setter: setterName,
                set_result: setResult,
                file_name: `${log.match_id}_${log.set_number}`,
                attack_type: log.attack_type
            };
        });
        this.processData();
    },
    processData() {
        const s = this.state;
        s.winData = s.allRawData.filter(row => row.set_result === 'W');
        s.loseData = s.allRawData.filter(row => row.set_result === 'L');
        s.totalData = s.allRawData;
        s.winSetCount = new Set(s.winData.map(r => r.file_name)).size || 1;
        s.loseSetCount = new Set(s.loseData.map(r => r.file_name)).size || 1;
        s.totalSetCount = new Set(s.totalData.map(r => r.file_name)).size || 1;
        // 統計計算
        s.overallStats.total = this.calculateStatistics(s.totalData, s.totalSetCount);
        s.overallStats.win = this.calculateStatistics(s.winData, s.winSetCount);
        s.overallStats.lose = this.calculateStatistics(s.loseData, s.loseSetCount);
        const passStats = this.calculatePassStats(s.totalData);
        this.renderPassStats(passStats);
        // フィルター生成
        s.allPlayersSet = new Set(s.allRawData.filter(r => r.player && r.player !== 'none').map(r => r.player));
        this.populatePlayerFilter(s.allPlayersSet); // ★修正: this. を追加
        s.allSettersSet = new Set(s.allRawData.filter(r => r.setter && r.setter !== 'none').map(r => r.setter));
        this.populateSetterFilter(s.allSettersSet); // ★修正: this. を追加
        this.updateOverallDisplay(s.overallStats.total); // ★修正: this. を追加
        this.triggerGraphAnimation(s.overallStats.total, s.overallStats.win, s.overallStats.lose); // ★修正: this. を追加
        if(this.dom.playerFilter) this.dom.playerFilter.value = "全員";
        this.onSpikerFilterChange();
        if(this.dom.setterPlayerFilter) this.dom.setterPlayerFilter.value = "全員";
        this.onSetterFilterChange();
        this.renderRotationAnalysis(this.state.totalData);
        this.renderReasonBreakdown(this.state.totalData);
        this.renderSetTransitionChart(this.state.allRawData);
        const totalTab = document.querySelector('.sub-tab-btn[data-filter="total"]');
        if(totalTab) totalTab.click();
    },
    // --- 計算ロジック ---
    calculateMetrics(dataset) {
        const TS = dataset.filter(row => 
            row.player && 
            row.player !== 'none' && 
            row.player !== 'NONE'
        ).length;
        if (TS === 0) return { TS:0, TK:0, TF:0, TE:0, PK:NaN, PE:NaN, PK_Effective:NaN, PF:NaN, PC:NaN, PA:NaN, PCA:NaN, PK_HighOpp:NaN, PB:NaN, P2:NaN };
        const TK = dataset.filter(row => row.result === 'kill').length;
        const TF = dataset.filter(row => row.result === 'fault').length;
        const TE = dataset.filter(row => row.result === 'effective').length;
        const TC_Total = dataset.filter(row => row.pass === 'CHANCE').length;
        const PC_Kills = dataset.filter(row => row.pass === 'CHANCE' && row.result === 'kill').length;
        const TA_Total = dataset.filter(row => row.pass === 'A').length;
        const PA_Kills = dataset.filter(row => row.pass === 'A' && row.result === 'kill').length;
        const TCA_Total = TC_Total + TA_Total;
        const PCA_Kills = PC_Kills + PA_Kills;
        const TCA_Good_Total = dataset.filter(row => (row.pass === 'CHANCE' || row.pass === 'A') && (row.set_distance === 'good' && row.set_length === 'good' && row.set_height === 'good')).length;
        const PCA_Good_Kills = dataset.filter(row => (row.pass === 'CHANCE' || row.pass === 'A') && (row.set_distance === 'good' && row.set_length === 'good' && row.set_height === 'good') && row.result === 'kill').length;
        const TB_Total = dataset.filter(row => row.pass === 'B').length;
        const PB_Kills = dataset.filter(row => row.pass === 'B' && row.result === 'kill').length;
        const T2_Total = dataset.filter(row => row.pass === 'S2' || row.pass === 'L2' || row.pass === 'O').length;
        const P2_Kills = dataset.filter(row => (row.pass === 'S2' || row.pass === 'L2' || row.pass === 'O') && row.result === 'kill').length;
        return {
            TS, TK, TF, TE,
            PK: (TK / TS), PE: ((TK - TF) / TS), PK_Effective: ((TK + TE) / TS), PF: (TF / TS),
            PC: (TC_Total === 0 ? NaN : PC_Kills / TC_Total),
            PA: (TA_Total === 0 ? NaN : PA_Kills / TA_Total),
            PCA: (TCA_Total === 0 ? NaN : PCA_Kills / TCA_Total),
            PK_HighOpp: (TCA_Good_Total === 0 ? NaN : PCA_Good_Kills / TCA_Good_Total),
            PB: (TB_Total === 0 ? NaN : PB_Kills / TB_Total),
            P2: (T2_Total === 0 ? NaN : P2_Kills / T2_Total),
        };
    },
    calculateStatistics(data, fileCount) {
        let denominator = fileCount || 1;
        const spikeData = data.filter(row => row.player && row.player !== 'none');
        const metrics = this.calculateMetrics(spikeData);
        let soOpp = 0, soWin = 0;
        let brOpp = 0, brWin = 0;
        data.forEach(row => {
            const isSideOutChance = (row.pass && row.pass !== 'UNKNOWN') || (row.attack_type === 'SERVE_ACE' && row.result === 'FAULT');
            let isOurPoint = false;
            if (['S','B','SA','OP'].includes(row.reason)) isOurPoint = true;
            else if (row.result === 'KILL' && !['MS','BS','SV','RE','EH','F'].includes(row.reason)) isOurPoint = true;
            if (isSideOutChance) {
                soOpp++;
                if (isOurPoint) soWin++;
            } else {
                brOpp++;
                if (isOurPoint) brWin++;
            }
        });
        metrics.SO_Rate = soOpp > 0 ? (soWin / soOpp) : 0;
        metrics.BR_Rate = brOpp > 0 ? (brWin / brOpp) : 0;
        metrics.AS = (metrics.TS / denominator);
        metrics.AK = (metrics.TK / denominator);
        metrics.AC = (spikeData.filter(row => row.pass === 'CHANCE').length / denominator);
        metrics.AA = (spikeData.filter(row => row.pass === 'A').length / denominator);
        return metrics;
    },
    calculateSpikerStats(data) {
        const stats = {};
        const allPlayers = new Set(data
            .filter(row => row.player && row.player !== 'none' && row.player !== 'NONE')
            .map(row => row.player)
        );
        allPlayers.forEach(player => {
            const playerData = data.filter(row => row.player === player);
            const spikeOnly = playerData.filter(r => !['SERVE','SERVE_ACE','SERVE_MISS'].includes(r.attack_type));
            stats[player] = this.calculateMetrics(spikeOnly);
            const serveData = playerData.filter(r => ['SERVE','SERVE_ACE','SERVE_MISS'].includes(r.attack_type));
            const serveTotal = serveData.length;
            const serveAce = serveData.filter(r => r.attack_type === 'SERVE_ACE').length;
            const serveMiss = serveData.filter(r => r.attack_type === 'SERVE_MISS').length;
            const serveEff = serveTotal > 0 ? ((serveAce*100 - serveMiss*25) / serveTotal) : 0;
            stats[player].serve = {
                total: serveTotal,
                ace: serveAce,
                miss: serveMiss,
                eff: serveEff
            };
        });
        return stats;
    },
    calculateSpikerTossStats(data) {
        const stats = {};
        const allPlayers = new Set(data.filter(row => row.player && row.player !== 'none' && row.player !== 'NONE').map(row => row.player));
        allPlayers.forEach(player => {
            const playerData = data.filter(row => row.player === player);
            stats[player] = {};
            const tossTypes = {
                "good": { total: 0, kill: 0, effective: 0, fault: 0 },
                "far": { total: 0, kill: 0, effective: 0, fault: 0 },
                "near": { total: 0, kill: 0, effective: 0, fault: 0 },
                "long": { total: 0, kill: 0, effective: 0, fault: 0 },
                "short": { total: 0, kill: 0, effective: 0, fault: 0 },
                "high": { total: 0, kill: 0, effective: 0, fault: 0 },
                "low": { total: 0, kill: 0, effective: 0, fault: 0 },
            };
            const inc = (key, row) => {
                if (!tossTypes[key]) {
                    return; 
                }
                tossTypes[key].total++;
                if (row.result === 'kill') tossTypes[key].kill++;
                if (row.result === 'effective') tossTypes[key].effective++;
                if (row.result === 'fault') tossTypes[key].fault++;
            };
            playerData.forEach(row => {
                if (row.set_distance === 'good' && row.set_length === 'good' && row.set_height === 'good') {
                    inc("good", row);
                } 
                else if (row.set_distance !== 'miss') { 
                    if (row.set_distance === 'far') inc("far", row);
                    else if (row.set_distance === 'near') inc("near", row);
                    
                    if (row.set_length === 'long') inc("long", row);
                    else if (row.set_length === 'short') inc("short", row);
                    
                    if (row.set_height === 'high') inc("high", row);
                    else if (row.set_height === 'low') inc("low", row);
                }
            });
            Object.keys(tossTypes).forEach(key => {
                const t = tossTypes[key];
                stats[player][key] = {
                    total: t.total,
                    kill: t.kill, 
                    rate: (t.total === 0) ? NaN : (t.kill / t.total),
                    rate_effective: (t.total === 0) ? NaN : ((t.kill + t.effective) / t.total),
                    rate_fault: (t.total === 0) ? NaN : (t.fault / t.total)
                };
            });
            stats[player].general = this.calculateMetrics(playerData);
        });
        return stats;
    },
    calculateSetterStats(data, selectedPlayer, cutFilter) {
        let setterData = data;
        if (selectedPlayer !== '全員') {
            setterData = data.filter(row => row.setter === selectedPlayer);
        }
        switch(cutFilter) {
            case 'A': setterData = setterData.filter(row => row.pass === 'A'); break;
            case 'B': setterData = setterData.filter(row => row.pass === 'B'); break;
            case 'CHANCE': setterData = setterData.filter(row => row.pass === 'CHANCE'); break;
            case 'AC': setterData = setterData.filter(row => row.pass === 'A' || row.pass === 'CHANCE'); break;
            case 'S2': setterData = setterData.filter(row => row.pass === 'S2' || row.pass === 'L2' || row.pass === 'O'); break;
        }
        setterData = setterData.filter(row => row.setter && row.setter !== null && ((row.player && row.player !== null) || row.set_distance === 'miss'));
        const stats = { good: 0, far: 0, near: 0, long: 0, short: 0, high: 0, low: 0, miss: 0, otherTotal: 0, totalTosses: setterData.length, top5Map: new Map() };
        if (stats.totalTosses === 0) { stats.top5= []; return stats; }
        setterData.forEach(row => {
            let qualityKey = "";
            if (row.set_distance === 'miss') { qualityKey = "×"; stats.miss++; } 
            else if (row.set_distance === 'good' && row.set_length === 'good' && row.set_height === 'good') { qualityKey = "〇"; stats.good++; } 
            else {
                stats.otherTotal++;
                const qualities = [];
                if (row.set_distance === 'far') { qualities.push("割"); stats.far++; }
                if (row.set_distance === 'near') { qualities.push("近"); stats.near++; }
                if (row.set_length === 'long') { qualities.push("長"); stats.long++; }
                if (row.set_length === 'short') { qualities.push("短"); stats.short++; }
                if (row.set_height === 'high') { qualities.push("高"); stats.high++; }
                if (row.set_height === 'low') { qualities.push("低"); stats.low++; }
                qualityKey = qualities.join(' × ') || "△";
            }
            stats.top5Map.set(qualityKey, (stats.top5Map.get(qualityKey) || 0) + 1);
        });
        stats.top5 = Array.from(stats.top5Map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
        return stats;
    },
    calculatePassStats(data) {
        const stats = {};
        const allPlayers = new Set(data.filter(row => row.pass && row.pass !== '').map(row => row.player));      
        const teamStats = {
            total: 0, A: 0, B: 0, C: 0, Error: 0,
            rateA: 0, rateB: 0, rateC: 0, rateE: 0
        };
        data.forEach(row => {
            if (!row.pass || row.pass === 'UNKNOWN') return;
            let quality = row.pass;
            if (['S2', 'L2', 'O'].includes(quality)) {
                quality = 'C';
            }
            if (['CHANCE','A', 'B', 'C'].includes(quality)) {
                teamStats.total++;
                teamStats[quality]++;
            }
            if (row.attack_type === 'SERVE_ACE') {
                teamStats.total++;
                teamStats.Error++;
            }
        });
        if (teamStats.total > 0) {
            teamStats.rateChance = (teamStats.Chance / teamStats.total * 100).toFixed(1);
            teamStats.rateA = (teamStats.A / teamStats.total * 100).toFixed(1);
            teamStats.rateB = (teamStats.B / teamStats.total * 100).toFixed(1);
            teamStats.rateC = (teamStats.C / teamStats.total * 100).toFixed(1);
            teamStats.rateE = (teamStats.Error / teamStats.total * 100).toFixed(1);
        }
        return teamStats;
    },
    renderPassStats(stats) {
        const container = document.getElementById('pass-summary');
        if (!container) return;
        container.innerHTML = ''; 
        container.style.display = 'flex';
        container.style.flexDirection = 'column';
        container.style.alignItems = 'center';
        container.style.padding = '20px';
        container.style.backgroundColor = 'white';
        const canvas = document.createElement('div');
        canvas.id = 'passPieChart';
        canvas.className = 'pie-chart-visual';
        canvas.style.width = '300px';
        canvas.style.height = '300px';
        canvas.style.margin = '0 auto 20px auto';
        canvas.style.borderRadius = '50%';
        const legend = document.createElement('div');
        legend.id = 'passPieLegend';
        legend.className = 'pie-legend';
        legend.style.marginBottom = '30px';
        legend.style.display = 'flex';
        legend.style.gap = '15px';
        legend.style.justifyContent = 'center';
        container.appendChild(canvas);
        container.appendChild(legend);
        const data = [stats.A, stats.B, stats.C, stats.Error];
        const labels = ["Aカット", "Bカット", "Cカット", "失点"];
        const colors = ["#2ECC71", "#F1C40F", "#E67E22", "#E74C3C"]; // 緑, 黄, 橙, 赤
        this.drawPieChart(canvas, legend, data, labels, colors);
        const tableDiv = document.createElement('div');
        tableDiv.style.width = '100%';
        tableDiv.style.maxWidth = '800px';
        tableDiv.style.overflowX = 'auto';
        tableDiv.innerHTML = `
            <table class="data-table" style="width:100%; border-collapse:collapse; text-align:center; font-size:16px;">
                <thead style="background-color:#f0f0f0; color:var(--navy); font-weight:bold;">
                    <tr>
                        <th style="padding:12px; border-bottom:2px solid #ccc;">総数</th>
                        <th style="padding:12px; border-bottom:2px solid #ccc;">A</th>
                        <th style="padding:12px; border-bottom:2px solid #ccc;">B</th>
                        <th style="padding:12px; border-bottom:2px solid #ccc;">C</th>
                        <th style="padding:12px; border-bottom:2px solid #ccc;">失点</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-bottom:1px solid #eee;">
                        <td style="padding:15px; font-weight:bold;">${stats.total}</td>
                        <td style="padding:15px; color:#2ECC71;">
                            ${stats.A} <span style="font-size:0.85em; color:#666;">(${stats.rateA}%)</span>
                        </td>
                        <td style="padding:15px; color:#F1C40F;">
                            ${stats.B} <span style="font-size:0.85em; color:#666;">(${stats.rateB}%)</span>
                        </td>
                        <td style="padding:15px; color:#E67E22;">
                            ${stats.C} <span style="font-size:0.85em; color:#666;">(${stats.rateC}%)</span>
                        </td>
                        <td style="padding:15px; color:#E74C3C;">
                            ${stats.Error} <span style="font-size:0.85em; color:#666;">(${stats.rateE}%)</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        `;
        container.appendChild(tableDiv);
    },
    populatePlayerFilter(allPlayersSet) {
        if (!this.dom.playerFilter) return;
        this.dom.playerFilter.innerHTML = '<option value="全員">全員</option>';
        Array.from(allPlayersSet).filter(player => player !== 'NONE').sort().forEach(player => {
            const option = document.createElement('option');
            option.value = player;
            option.textContent = player;
            this.dom.playerFilter.appendChild(option);
        });
    },
    populateSetterFilter(allSettersSet) {
        if (!this.dom.setterPlayerFilter) return;
        this.dom.setterPlayerFilter.innerHTML = '<option value="全員">全員</option>';
        Array.from(allSettersSet).sort().forEach(player => {
            const option = document.createElement('option');
            option.value = player;
            option.textContent = player;
            this.dom.setterPlayerFilter.appendChild(option);
        });
    },
    updateOverallDisplay(stats) {
        const formatRate = (rate) => isNaN(rate) ? '--.-%' : `${(rate * 100).toFixed(1)}%`;
        const d = this.dom.overallDisplay;
        if (d.TS) d.TS.textContent = `${stats.TS.toFixed(0)} 本`;
        if (d.TK) d.TK.textContent = `${stats.TK.toFixed(0)} 本`;
        if (d.AS) d.AS.textContent = `${stats.AS.toFixed(1)} 本`;
        if (d.AK) d.AK.textContent = `${stats.AK.toFixed(1)} 本`;
        if (d.AC) d.AC.textContent = `${stats.AC.toFixed(1)} 本`;
        if (d.AA) d.AA.textContent = `${stats.AA.toFixed(1)} 本`;
        if (d.PK) d.PK.textContent = formatRate(stats.PK);
        if (d.PE) d.PE.textContent = formatRate(stats.PE);
        if (d.PCA) d.PCA.textContent = formatRate(stats.PCA);
        if (d.PF) d.PF.textContent = formatRate(stats.PF);
        const elSO = document.getElementById('stat_SO');
        const elBR = document.getElementById('stat_BR');
        if (elSO) elSO.textContent = formatRate(stats.SO_Rate);
        if (elBR) elBR.textContent = formatRate(stats.BR_Rate);
    },
    triggerGraphAnimation(total, win, lose) {
        const bars = document.querySelectorAll('#overall-graphs .bar-fill');
        bars.forEach(bar => { bar.style.transition = 'none'; bar.style.width = '0%'; });
        setTimeout(() => {
            bars.forEach(bar => { bar.style.transition = ''; });
            const b = this.dom.overallBars;
            if (b.PK_total) b.PK_total.style.width = `${(total.PK || 0) * 100}%`;
            if (b.PK_win) b.PK_win.style.width = `${(win.PK || 0) * 100}%`;
            if (b.PK_lose) b.PK_lose.style.width = `${(lose.PK || 0) * 100}%`;
            if (b.PE_total) b.PE_total.style.width = `${(total.PE || 0) * 100}%`;
            if (b.PE_win) b.PE_win.style.width = `${(win.PE || 0) * 100}%`;
            if (b.PE_lose) b.PE_lose.style.width = `${(lose.PE || 0) * 100}%`;
            if (b.PCA_total) b.PCA_total.style.width = `${(total.PCA || 0) * 100}%`;
            if (b.PCA_win) b.PCA_win.style.width = `${(win.PCA || 0) * 100}%`;
            if (b.PCA_lose) b.PCA_lose.style.width = `${(lose.PCA || 0) * 100}%`;
            if (b.PF_total) b.PF_total.style.width = `${(total.PF || 0) * 100}%`;
            if (b.PF_win) b.PF_win.style.width = `${(win.PF || 0) * 100}%`;
            if (b.PF_lose) b.PF_lose.style.width = `${(lose.PF || 0) * 100}%`;
        }, 20);
    },
    onSpikerFilterChange() {
        if (!this.dom.playerFilter || !this.dom.setFilter) return;
        const selectedPlayer = this.dom.playerFilter.value;
        const selectedSet = this.dom.setFilter.value;
        const baseData = (selectedSet === 'win') ? this.state.winData : (selectedSet === 'lose') ? this.state.loseData : this.state.totalData;
        const baseSetCount = (selectedSet === 'win') ? this.state.winSetCount : (selectedSet === 'lose') ? this.state.loseSetCount : this.state.totalSetCount;
        if (selectedPlayer === '全員') {
            const stats = this.calculateSpikerStats(baseData);
            const stats2 = this.calculateSpikerTossStats(baseData);
            this.renderSpikerTable(stats, baseSetCount);
            this.renderSpikerTossTable(stats2);
            this.dom.spikerTableView.classList.remove('hidden');
            this.dom.spikerTableView2.classList.remove('hidden');
            this.dom.spikerGraphView.classList.add('hidden');
            this.dom.spikerTossGraphView.classList.add('hidden');
        } else {
            const pData = baseData.filter(r => r.player === selectedPlayer);
            const stats = this.calculateMetrics(pData);
            const pBaseData = baseData.filter(r => r.player === selectedPlayer);
            const stats2 = this.calculateSpikerTossStats(pBaseData);
            this.updateSpikerGraphDisplay(stats);
            this.triggerSpikerGraphAnimation(
                this.calculateMetrics(this.state.totalData.filter(r => r.player === selectedPlayer)),
                this.calculateMetrics(this.state.winData.filter(r => r.player === selectedPlayer)),
                this.calculateMetrics(this.state.loseData.filter(r => r.player === selectedPlayer))
            );
            if (stats2[selectedPlayer]) {
                this.renderSpikerTossGraph(stats2[selectedPlayer]);
            } else {
                this.renderSpikerTossGraph({});
            }
            this.dom.spikerTableView.classList.add('hidden');
            this.dom.spikerTableView2.classList.add('hidden');
            this.dom.spikerGraphView.classList.remove('hidden');
            this.dom.spikerTossGraphView.classList.remove('hidden');
        }
        this.updateSpikerVisibility(); // タブに応じた表示切替
    },
    onSetterFilterChange() {
        if (!this.dom.setterPlayerFilter) return;
        const selectedPlayer = this.dom.setterPlayerFilter.value;
        const selectedSet = this.dom.setterSetFilter.value;
        const selectedCut = this.dom.setterCutFilter.value;
        const baseData = (selectedSet === 'win') ? this.state.winData : (selectedSet === 'lose') ? this.state.loseData : this.state.totalData;
        let setterData = baseData;
        if (selectedPlayer !== '全員') {
            setterData = setterData.filter(row => row.setter === selectedPlayer);
        }
        if (selectedCut) {
            switch(selectedCut) {
                case 'A': setterData = setterData.filter(row => row.pass === 'A'); break;
                case 'B': setterData = setterData.filter(row => row.pass === 'B'); break;
                case 'CHANCE': setterData = setterData.filter(row => row.pass === 'CHANCE'); break;
                case 'AC': setterData = setterData.filter(row => ['A', 'CHANCE'].includes(row.pass)); break;
                case 'S2': setterData = setterData.filter(row => ['S2', 'L2', 'O', 'C'].includes(row.pass)); break; // Pass C/Bad
            }
        }
        const stats = this.calculateSetterStats(setterData, selectedPlayer, selectedCut); // ※引数注意
        this.renderSetterStats(stats);
        this.renderSetterDistributionChart(setterData);
    },
    onSpikerTabChange(e) {
        const tabs = document.querySelectorAll('#spiker-analysis .tab-btn');
        tabs.forEach(btn => btn.classList.remove('selected'));
        e.target.classList.add('selected');
        this.updateSpikerVisibility();
    },
    updateSpikerVisibility() {
        const selectedPlayer = this.dom.playerFilter.value;
        const selectedTabBtn = document.querySelector('#spiker-analysis .tab-btn.selected');
        if (!selectedTabBtn) return;
        const selectedTab = selectedTabBtn.id;
        const isAll = selectedPlayer === '全員';
        const isTab1 = selectedTab === 'spikerTab1';
        this.dom.spikerTableView.classList.toggle('hidden', !(isAll && isTab1));
        this.dom.spikerTableView2.classList.toggle('hidden', !(isAll && !isTab1));
        this.dom.spikerGraphView.classList.toggle('hidden', !(!isAll && isTab1));
        this.dom.spikerTossGraphView.classList.toggle('hidden', !(!isAll && !isTab1));
    },
    renderSpikerTable(spikerStats, denominator) {
        if (!this.dom.spikerTableBody) return;
        this.dom.spikerTableBody.innerHTML = '';
        const serveTable = document.getElementById('tbl-spiker-serve');
        const serveBody = serveTable ? serveTable.querySelector('tbody') : null;
        if (serveBody) serveBody.innerHTML = '';
        const sortedPlayers = Object.keys(spikerStats).sort();
        const formatRate = (rate) => isNaN(rate) ? '--.-%' : `${(rate * 100).toFixed(1)}%`;
        sortedPlayers.forEach(player => {
            const s = spikerStats[player];
            const sv = s.serve;
            const avgSpikes = (s.TS / denominator).toFixed(1);
            const classes = {
                PK: this.getStatColorClass('PK', s.PK),
                PE: this.getStatColorClass('PE', s.PE),
                PK_Effective: this.getStatColorClass('PK_Effective', s.PK_Effective),
                PF: this.getStatColorClass('PF', s.PF),
                PC: this.getStatColorClass('PC', s.PC),
                PA: this.getStatColorClass('PA', s.PA),
                PCA: this.getStatColorClass('PCA', s.PCA),
                PK_HighOpp: this.getStatColorClass('PK_HighOpp', s.PK_HighOpp),
                PB: this.getStatColorClass('PB', s.PB),
                P2: this.getStatColorClass('P2', s.P2),
            };
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${player}</td><td>${avgSpikes}</td>
                <td class="${classes.PK}">${formatRate(s.PK)}</td>
                <td class="${classes.PE}">${formatRate(s.PE)}</td>
                <td class="${classes.PK_Effective}">${formatRate(s.PK_Effective)}</td>
                <td class="${classes.PF}">${formatRate(s.PF)}</td>
                <td class="${classes.PC}">${formatRate(s.PC)}</td>
                <td class="${classes.PA}">${formatRate(s.PA)}</td>
                <td class="${classes.PCA}">${formatRate(s.PCA)}</td>
                <td class="${classes.PK_HighOpp}">${formatRate(s.PK_HighOpp)}</td>
                <td class="${classes.PB}">${formatRate(s.PB)}</td>
                <td class="${classes.P2}">${formatRate(s.P2)}</td>
            `;
            this.dom.spikerTableBody.appendChild(row);
            if (serveBody && sv) {
                const missRate = sv.total > 0 ? (sv.miss / sv.total) : 0;
                const rowServe = document.createElement('tr');
                rowServe.innerHTML = `
                    <td style="font-weight:bold; min-width:80px;">${player}</td>
                    <td>${sv.total}</td>
                    <td style="color:blue; font-weight:bold;">${sv.ace}</td>
                    <td style="color:red;">${sv.miss}</td>
                    <td style="font-weight:bold;">${formatRate(sv.eff)}</td>
                    <td style="color:#666; font-size:0.9em;">${formatRate(missRate)}</td>
                `;
                serveBody.appendChild(rowServe);
            }
        });
    },
    renderSpikerTossTable(spikerStats) {
        if (!this.dom.spikerTossTableBody) return;
        this.dom.spikerTossTableBody.innerHTML = '';
        const sortedPlayers = Object.keys(spikerStats).sort();
        const formatToss = (s) => (!s || s.total === 0) ? '-- (--)' : `${s.total} (${s.kill})`;
        const formatRate = (rate) => isNaN(rate) ? '--.-%' : `${(rate * 100).toFixed(1)}%`;
        sortedPlayers.forEach(player => {
            const stats = spikerStats[player];
            const general = stats.general;
            if (!general) return;
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${player}</td>
                <td class="${this.getStatColorClass('PK', general.PK)}">${formatRate(general.PK)}</td>
                <td class="${this.getStatColorClass('PE', general.PE)}">${formatRate(general.PE)}</td>
                <td class="${this.getStatColorClass('PK_Effective', general.PK_Effective)}">${formatRate(general.PK_Effective)}</td>
                <td class="${this.getStatColorClass('PF', general.PF)}">${formatRate(general.PF)}</td>
                <td>${formatToss(stats.good)}</td><td>${formatToss(stats.far)}</td><td>${formatToss(stats.near)}</td>
                <td>${formatToss(stats.long)}</td><td>${formatToss(stats.short)}</td>
                <td>${formatToss(stats.high)}</td><td>${formatToss(stats.low)}</td>
            `;
            this.dom.spikerTossTableBody.appendChild(row);
        });
    },
    getStatColorClass(key, value) {
        if (isNaN(value)) return '';
        if (['PK','PA','PC','PCA'].includes(key)) {
            if (value >= 0.4) return 'text-red-strong';
            if (value < 0.3) return 'text-light-blue';
        }
        if (key === 'PE') {
            if (value >= 0.2) return 'text-red-strong';
            if (value < 0) return 'text-light-blue';
        }
        if (['PK_Effective','PK_HighOpp'].includes(key)) {
            if (value >= 0.5) return 'text-red-strong';
            if (value < 0.35) return 'text-light-blue';
        }
        if (key === 'PF') {
            if (value >= 0.2) return 'text-light-blue';
            if (value <= 0.1) return 'text-red-strong';
        }
        if (['PB','P2'].includes(key)) {
            if (value >= 0.3) return 'text-red-strong';
            if (value < 0.2) return 'text-light-blue';
        }
        return '';
    },
    updateSpikerGraphDisplay(stats) {
        if (!this.dom.spikerGraphDisplay.TS) return;
        const formatRate = (rate) => isNaN(rate) ? '--.-%' : `${(rate * 100).toFixed(1)}%`;
        const d = this.dom.spikerGraphDisplay;
        d.TS.textContent = `${stats.TS.toFixed(0)} 本`;
        d.TK.textContent = `${stats.TK.toFixed(0)} 本`;
        d.TF.textContent = `${stats.TF.toFixed(0)} 本`;
        d.PK.textContent = formatRate(stats.PK);
        d.PE.textContent = formatRate(stats.PE);
        d.PKE.textContent = formatRate(stats.PK_Effective);
        d.PF.textContent = formatRate(stats.PF);
        d.PC.textContent = formatRate(stats.PC);
        d.PA.textContent = formatRate(stats.PA);
        d.PCA.textContent = formatRate(stats.PCA);
        d.PKH.textContent = formatRate(stats.PK_HighOpp);
        d.PB.textContent = formatRate(stats.PB);
        d.P2.textContent = formatRate(stats.P2);
    },
    triggerSpikerGraphAnimation(total, win, lose) {
        const bars = document.querySelectorAll('#spiker-graphs .bar-fill');
        bars.forEach(bar => { bar.style.transition = 'none'; bar.style.width = '0%'; });
        setTimeout(() => {
            bars.forEach(bar => { bar.style.transition = ''; });
            const metrics = ["PK", "PE", "PKE", "PF", "PC", "PA", "PCA", "PKH", "PB", "P2"];
            metrics.forEach(metric => {
                const barTotal = document.getElementById(`bar_${metric}_total_spiker`);
                const barWin = document.getElementById(`bar_${metric}_win_spiker`);
                const barLose = document.getElementById(`bar_${metric}_lose_spiker`);
                if (barTotal) barTotal.style.width = `${(total[metric] || 0) * 100}%`;
                if (barWin) barWin.style.width = `${(win[metric] || 0) * 100}%`;
                if (barLose) barLose.style.width = `${(lose[metric] || 0) * 100}%`;
            });
        }, 20);
    },
    renderSpikerTossGraph(tossStats) {
        const keys = ["good", "far", "near", "long", "short", "high", "low"];
        keys.forEach(key => {
            const stats = tossStats[key];
            const totalEl = document.getElementById(`stat_${key}_spiker`);
            const barK = document.getElementById(`bar_${key}_K_spiker`);
            const barE = document.getElementById(`bar_${key}_E_spiker`);
            const barF = document.getElementById(`bar_${key}_F_spiker`);
            if (totalEl) {
                if (!stats || stats.total === 0) {
                    totalEl.innerHTML = `<span style="color: #999;">--</span>`;
                } else {
                    const k = (stats.rate * 100).toFixed(1);
                    const e = (stats.rate_effective * 100).toFixed(1);
                    const f = (stats.rate_fault * 100).toFixed(1);
                    totalEl.innerHTML = `<span style="color:#2ECC71">${isNaN(stats.rate)?'--':k}%</span>/<span style="color:#F39C12">${isNaN(stats.rate_effective)?'--':e}%</span>/<span style="color:var(--red-strong)">${isNaN(stats.rate_fault)?'--':f}%</span>`;
                }
            }
            if(barK) barK.style.width = `${(stats && !isNaN(stats.rate) ? stats.rate * 100 : 0)}%`;
            if(barE) barE.style.width = `${(stats && !isNaN(stats.rate_effective) ? stats.rate_effective * 100 : 0)}%`;
            if(barF) barF.style.width = `${(stats && !isNaN(stats.rate_fault) ? stats.rate_fault * 100 : 0)}%`;
        });
    },
    renderSetterStats(stats) {
        const tableContainer = document.getElementById('setter-table-view');
        const list = document.getElementById('setterTop5List');
        const chart1 = document.getElementById('setterPieChart1');
        const legend1 = document.getElementById('setterPieLegend1');
        const chart2 = document.getElementById('setterPieChart2');
        const legend2 = document.getElementById('setterPieLegend2');
        if (!tableContainer) return;
        const total = stats.totalTosses;
        let tableHTML = '<table style="width:100%; border-collapse:collapse;">';
        if (total === 0) {
            tableHTML += '<tbody><tr><td colspan="9" style="text-align:center; padding:20px; color:#888;">データがありません</td></tr></tbody>';
            if(list) list.innerHTML = '<p class="no-files-message" style="text-align:center;">データなし</p>';
            if(chart1) chart1.style.display = 'none';
            if(chart2) chart2.style.display = 'none';
            if(legend1) legend1.innerHTML = '';
            if(legend2) legend2.innerHTML = '';
        } else {
            tableHTML += `
                <thead>
                    <tr style="background-color:#f5f5f5;">
                        <th style="width:50px;"></th>
                        <th class="th-good">〇</th>
                        <th class="th-bad">割</th>
                        <th class="th-bad">近</th>
                        <th class="th-bad">長</th>
                        <th class="th-bad">短</th>
                        <th class="th-bad">高</th>
                        <th class="th-bad">低</th>
                        <th class="th-miss">ミス</th>
                    </tr>
                </thead>
                <tbody>
                    <tr style="border-bottom:1px solid #eee;">
                        <td style="color:#00478c;">数</td>
                        <td>${stats.good}</td>
                        <td>${stats.far}</td>
                        <td>${stats.near}</td>
                        <td>${stats.long}</td>
                        <td>${stats.short}</td>
                        <td>${stats.high}</td>
                        <td>${stats.low}</td>
                        <td>${stats.miss}</td>
                    </tr>
                    <tr>
                        <td style="color:#00478c;">率</td>
                        <td>${(stats.good / total * 100).toFixed(1)}%</td>
                        <td>${(stats.far / total * 100).toFixed(1)}%</td>
                        <td>${(stats.near / total * 100).toFixed(1)}%</td>
                        <td>${(stats.long / total * 100).toFixed(1)}%</td>
                        <td>${(stats.short / total * 100).toFixed(1)}%</td>
                        <td>${(stats.high / total * 100).toFixed(1)}%</td>
                        <td>${(stats.low / total * 100).toFixed(1)}%</td>
                        <td>${(stats.miss / total * 100).toFixed(1)}%</td>
                    </tr>
                </tbody>
            `;
            // --- 2. TOP5リスト描画 ---
            if (list) {
                list.innerHTML = '';
                if(this.dom.setterTop5Header) this.dom.setterTop5Header.textContent = "トスの質 組合せ Top5";
                stats.top5.forEach(([key, count], index) => {
                    const li = document.createElement('li');
                    li.textContent = `${index + 1}. ${key} (${count}本)`;
                    list.appendChild(li);
                });
            }
            // --- 3. 円グラフ描画 ---
            const title1 = document.querySelector('.setter-grid-pie1 h3');
            if(title1) title1.textContent = "トスの内訳";
            const title2 = document.querySelector('.setter-grid-pie2 h3');
            if(title2) title2.textContent = "「その他」の内訳";
            const pie1Data = [stats.good, stats.otherTotal + stats.miss]; 
            const pie1Labels = ["〇 (Good)", "△ (Other)"];
            const pie1Colors = ["#00478c", "#FF8C00"]; // 紺, オレンジ
            if(stats.miss > 0) {
                pie1Data[1] = stats.otherTotal;
                pie1Data.push(stats.miss);
                pie1Labels.push("× (Miss)");
                pie1Colors.push("#E74C3C");
            }
            this.drawPieChart(chart1, legend1, pie1Data, pie1Labels, pie1Colors);
            const pie2Data = [stats.far, stats.near, stats.long, stats.short, stats.high, stats.low];
            const pie2Labels = ["割", "近", "長", "短", "高", "低"];
            const pie2Colors = ["#3498DB", "#2ECC71", "#9B59B6", "#F1C40F", "#E67E22", "#E74C3C"]; 
            this.drawPieChart(chart2, legend2, pie2Data, pie2Labels, pie2Colors);
        }
        tableContainer.innerHTML = tableHTML + '</table>';
    },
    drawPieChart(canvasEl, legendEl, data, labels, colors) {
        if (!canvasEl || !legendEl) return;
        legendEl.innerHTML = '';
        const total = data.reduce((a, b) => a + b, 0);
        if (total === 0) {
            canvasEl.style.display = 'none';
            legendEl.innerHTML = 'データなし';
            return;
        }
        canvasEl.style.display = 'block';
        let cumulativePercent = 0;
        const gradients = data.map((value, index) => {
            const percent = (value / total) * 100;
            if (percent === 0) return '';
            const start = cumulativePercent;
            const end = cumulativePercent + percent;
            cumulativePercent = end;
            return `${colors[index]} ${start}%, ${colors[index]} ${end}%`;
        });
        canvasEl.style.background = `conic-gradient(${gradients.filter(g => g).join(', ')})`;
        canvasEl.style.borderRadius = '50%';
        canvasEl.style.aspectRatio = '1 / 1';
        canvasEl.style.width = '100%';
        canvasEl.style.maxWidth = '300px';
        labels.forEach((label, index) => {
            if (data[index] > 0) {
                const percent = (data[index] / total * 100).toFixed(1);
                const item = document.createElement('div');
                item.className = 'pie-legend-item';
                item.innerHTML = `<div class="legend-color-box" style="background-color: ${colors[index]}"></div>${label} (${percent}%)`;
                legendEl.appendChild(item);
            }
        });
    },
    chartInstances: {},
    renderSetTransitionChart(rawData) {
        const ctx = document.getElementById('chart-set-transition');
        if (!ctx) return;
        if (this.chartInstances['setTransition']) {
            this.chartInstances['setTransition'].destroy();
        }
        const setNumbers = [...new Set(rawData.map(d => d.set_number))].sort((a,b)=>a-b);
        const killRates = [];
        const effRates = [];
        setNumbers.forEach(setNum => {
            const setData = rawData.filter(d => d.set_number === setNum);
            const spikes = setData.filter(d => d.player && d.player !== 'none');
            const metrics = this.calculateMetrics(spikes); // 既存の計算関数を再利用
            killRates.push(metrics.PK ? (metrics.PK * 100).toFixed(1) : 0);
            effRates.push(metrics.PE ? (metrics.PE * 100).toFixed(1) : 0);
        });
        this.chartInstances['setTransition'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: setNumbers.map(n => `第${n}セット`),
                datasets: [
                    {
                        label: '決定率 (%)',
                        data: killRates,
                        borderColor: '#00478c', // V-Metrics Navy
                        backgroundColor: '#00478c',
                        borderWidth: 2,
                        tension: 0.3, // 少し曲線を滑らかに
                        pointRadius: 4,
                        pointBackgroundColor: '#fff',
                        pointBorderWidth: 2
                    },
                    {
                        label: '効果率 (%)',
                        data: effRates,
                        borderColor: '#2ECC71', // Green
                        backgroundColor: '#2ECC71',
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: 4,
                        pointBackgroundColor: '#fff',
                        pointBorderWidth: 2,
                        borderDash: [5, 5] // 点線にする
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            usePointStyle: true,
                            boxWidth: 8
                        }
                    },
                    tooltip: {
                        mode: 'index',
                        intersect: false,
                        backgroundColor: 'rgba(0, 71, 140, 0.9)', // ツールチップも紺色に
                        titleFont: { size: 14 },
                        bodyFont: { size: 14 },
                        padding: 10
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100, // 100%が上限
                        grid: {
                            color: '#eee' // グリッドは薄く
                        },
                        ticks: {
                            callback: function(value) { return value + "%" }
                        }
                    },
                    x: {
                        grid: {
                            display: false // 縦のグリッドは消してスッキリさせる
                        }
                    }
                },
                interaction: {
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
    },
    renderSetterDistributionChart(setterData) {
        const ctx = document.getElementById('chart-setter-distribution');
        if (!ctx) return;
        if (this.chartInstances['setterDist']) {
            this.chartInstances['setterDist'].destroy();
        }
        const distribution = {};
        let totalTosses = 0;
        setterData.forEach(row => {
            if (row.player && row.player !== 'none' && row.player !== 'NONE') {
                const name = row.player;
                distribution[name] = (distribution[name] || 0) + 1;
                totalTosses++;
            }
        });
        if (totalTosses === 0) return;
        const sortedPlayers = Object.keys(distribution).sort((a, b) => distribution[b] - distribution[a]);
        const dataValues = sortedPlayers.map(name => distribution[name]);
        const colors = [
            '#00478c', // Navy (1位)
            '#2ECC71', // Green (2位)
            '#F1C40F', // Yellow (3位)
            '#E74C3C', // Red
            '#9B59B6', // Purple
            '#34495E', // Dark Gray
            '#95A5A6'  // Light Gray
        ];
        this.chartInstances['setterDist'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sortedPlayers,
                datasets: [{
                    data: dataValues,
                    backgroundColor: colors.slice(0, sortedPlayers.length),
                    borderColor: '#fff',
                    borderWidth: 2,
                    hoverOffset: 4
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '60%', // ドーナツの穴の大きさ
                plugins: {
                    legend: {
                        position: 'right', // 凡例を右側に配置
                        labels: {
                            boxWidth: 12,
                            padding: 15,
                            font: { size: 12 }
                        }
                    },
                    title: {
                        display: true,
                        text: `総トス数: ${totalTosses}本`,
                        position: 'bottom',
                        padding: 20,
                        color: '#666'
                    },
                    tooltip: {
                        backgroundColor: 'rgba(0, 71, 140, 0.9)',
                        bodyFont: { size: 14 },
                        callbacks: {
                            label: function(context) {
                                const label = context.label || '';
                                const value = context.raw || 0;
                                const percentage = ((value / totalTosses) * 100).toFixed(1) + '%';
                                return ` ${label}: ${value}本 (${percentage})`;
                            }
                        }
                    }
                },
                layout: {
                    padding: 20
                }
            }
        });
    },
    renderRotationAnalysis(data) {
        const ctx = document.getElementById('chart-rotation-breakdown');
        if (!ctx) return;
        if (this.chartInstances['rotAnalysis']) this.chartInstances['rotAnalysis'].destroy();
        const rotStats = Array(7).fill(0).map(() => ({
            soTotal: 0, soWin: 0, // サイドアウト機会、成功
            brTotal: 0, brWin: 0  // ブレイク機会、成功
        }));
        data.forEach(row => {
            const rot = row.rotation_number || 1; // rotation_numberがない場合は1と仮定
            let isOurPoint = false;
            if (['S','B','SA','OP'].includes(row.reason)) isOurPoint = true;
            else if (row.result === 'KILL' && !['MS','BS','SV','RE','EH','F'].includes(row.reason)) isOurPoint = true;
            const isSideOutOpp = (row.pass && row.pass !== 'UNKNOWN');
            if (isSideOutOpp) {
                rotStats[rot].soTotal++;
                if (isOurPoint) rotStats[rot].soWin++;
            } else {
                rotStats[rot].brTotal++;
                if (isOurPoint) rotStats[rot].brWin++;
            }
        });
        const labels = ['Rot 1', 'Rot 2', 'Rot 3', 'Rot 4', 'Rot 5', 'Rot 6'];
        const soRates = [];
        const brRates = [];
        for (let i = 1; i <= 6; i++) {
            const s = rotStats[i];
            soRates.push(s.soTotal ? (s.soWin / s.soTotal * 100).toFixed(1) : 0);
            brRates.push(s.brTotal ? (s.brWin / s.brTotal * 100).toFixed(1) : 0);
        }
        this.chartInstances['rotAnalysis'] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'サイドアウト率',
                        data: soRates,
                        backgroundColor: '#00478c', // Navy
                        order: 1
                    },
                    {
                        label: 'ブレイク率',
                        data: brRates,
                        backgroundColor: '#E67E22', // Orange
                        order: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { beginAtZero: true, max: 100, title: {display:true, text:'%'} }
                },
                plugins: {
                    tooltip: {
                        callbacks: {
                            label: (ctx) => {
                                const val = ctx.raw;
                                const rotIdx = ctx.dataIndex + 1;
                                const s = rotStats[rotIdx];
                                const detail = ctx.datasetIndex === 0 
                                    ? `${s.soWin}/${s.soTotal}` 
                                    : `${s.brWin}/${s.brTotal}`;
                                return `${ctx.dataset.label}: ${val}% (${detail})`;
                            }
                        }
                    }
                }
            }
        });
    },
    // 2. 得失点内訳 (円グラフ2つ)
    renderReasonBreakdown(data) {
        this.renderPie(data, 'chart-point-breakdown', true);
        this.renderPie(data, 'chart-error-breakdown', false);
    },
    renderPie(data, canvasId, isPoint) {
        const ctx = document.getElementById(canvasId);
        if (!ctx) return;
        const key = isPoint ? 'piePoint' : 'pieError';
        if (this.chartInstances[key]) this.chartInstances[key].destroy();
        const counts = {};
        let total = 0;
        const LABELS = {
            'S': 'スパイク', 'B': 'ブロック', 'SA': 'Sエース', 'OP': '相手ミス',
            'MS': 'スパイクミス', 'BS': '被ブロック', 'SV': 'サーブミス', 'RE': 'レシーブミス', 'F': '反則', 'EH':'ハンドリング'
        };
        data.forEach(row => {
            const r = row.reason;
            if (!r) return;
            let isRowPoint = ['S','B','SA','OP'].includes(r);
            if (!isPoint) isRowPoint = !isRowPoint;
            if (isPoint === isRowPoint) {
                const label = LABELS[r] || r;
                counts[label] = (counts[label] || 0) + 1;
                total++;
            }
        });
        if (total === 0) return; // データなし
        const sortedKeys = Object.keys(counts).sort((a,b) => counts[b] - counts[a]);
        const values = sortedKeys.map(k => counts[k]);
        const colorsPoint = ['#00478c', '#2ECC71', '#F1C40F', '#34495E']; // 青・緑・黄
        const colorsError = ['#E74C3C', '#E67E22', '#95A5A6', '#8E44AD', '#34495E']; // 赤・橙・灰
        this.chartInstances[key] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: sortedKeys,
                datasets: [{
                    data: values,
                    backgroundColor: isPoint ? colorsPoint : colorsError,
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'right', labels: { boxWidth: 12 } },
                    title: {
                        display: true,
                        text: `Total: ${total}点`,
                        position: 'bottom'
                    }
                }
            }
        });
    },
    switchTab(tabName) {
        if (tabName === 'spike') {
            document.querySelector('.tab-btn[data-view="spiker"]').click();
        } else if (tabName === 'pass') {
        } else if (tabName === 'toss') {
            document.querySelector('.tab-btn[data-view="setter"]').click();
        }
    },
    async toggleSharePopup(show) {
        if (!document.getElementById('share-popup')) {
            if (show) {
                await this.shareMatchSummaryText();
            }
            return;
        }
    },
    async shareMatchSummaryText() {
        const match = await db.matchInfo.get(currentMatchId);
        const summaries = await db.setSummary.where('match_id').equals(currentMatchId).toArray();
        summaries.sort((a,b) => a.set_number - b.set_number);
        const date = match ? match.match_date : '-';
        const opp = match ? match.opponent_name : '相手チーム';
        let text = `【試合結果】\n${date} vs ${opp}\n\n`;
        let ourTotal = 0;
        let oppTotal = 0;
        summaries.forEach(s => {
            text += `第${s.set_number}セット: ${s.our_final_score} - ${s.opponent_final_score} ${s.our_final_score > s.opponent_final_score ? '○' : '●'}\n`;
            if (s.our_final_score > s.opponent_final_score) ourTotal++;
            else oppTotal++;
        });
        text += `\nセットカウント: ${ourTotal} - ${oppTotal}\n`;
        text += `\n#VMetrics`;
        if (navigator.clipboard) {
            try {
                await navigator.clipboard.writeText(text);
                UIManager.showFeedback("試合結果をクリップボードにコピーしました！\nSNSなどに貼り付けられます。");
            } catch (err) {
                console.error('コピー失敗', err);
                alert("結果:\n" + text);
            }
        } else {
            alert("結果:\n" + text);
        }
    },
    // 共有ロジック
    toggleSharePopup(show) {
        const overlay = document.getElementById('share-overlay');
        if (!overlay) return;
        
        if (show) {
            this.initializeSharePopup();
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
        }
    },
    initializeSharePopup() {
        const container = document.getElementById('share-options-container');
        const btnPng = document.getElementById('btn-share-png');
        const btnPdf = document.getElementById('btn-share-pdf');
        if (!container) return;
        container.className = 'share-option-list';
        container.innerHTML = '';
        this.state.selectedShareOptions = []; 
        const options = [
            { id: 'overall', title: '全体分析 (Overall)', desc: '勝敗・得失点・ローテ別成績' },
            { id: 'spiker_atk', title: 'スパイカー成績 (攻撃)', desc: '決定率・効果率・詳細データ' },
            { id: 'spiker_srv', title: 'スパイカー成績 (サーブ)', desc: 'エース・ミス・効果率' },
            { id: 'setter_dist', title: 'セッター配球', desc: '配球チャート・詳細データ' }
        ];
        options.forEach(opt => {
            const item = document.createElement('div');
            item.className = 'share-option-item';
            item.innerHTML = `
                <div class="share-option-check"></div>
                <div class="share-option-text">
                    <span class="share-option-title">${opt.title}</span>
                    <span class="share-option-desc">${opt.desc}</span>
                </div>
            `;
            item.onclick = () => {
                item.classList.toggle('selected');
                
                if (item.classList.contains('selected')) {
                    this.state.selectedShareOptions.push(opt.id);
                } else {
                    this.state.selectedShareOptions = this.state.selectedShareOptions.filter(id => id !== opt.id);
                }
                const hasSel = this.state.selectedShareOptions.length > 0;
                btnPng.disabled = !hasSel;
                btnPdf.disabled = !hasSel;
                btnPng.style.opacity = hasSel ? 1 : 0.5;
                btnPdf.style.opacity = hasSel ? 1 : 0.5;
            };
            container.appendChild(item);
        });
        btnPng.onclick = () => this.handleExportClick('png');
        btnPdf.onclick = () => this.handleExportClick('pdf');
        btnPng.disabled = true; btnPng.style.opacity = 0.5;
        btnPdf.disabled = true; btnPdf.style.opacity = 0.5;
    },
    async handleExportClick(format) {
        const btn = (format === 'png') ? document.getElementById('btn-share-png') : document.getElementById('btn-share-pdf');
        const originalText = btn.textContent;
        btn.textContent = "生成中...";
        btn.disabled = true;
        try {
            const wrapper = document.createElement('div');
            wrapper.style.position = 'fixed';
            wrapper.style.left = '-9999px';
            wrapper.style.top = '0';
            wrapper.style.width = '800px'; // A4幅に近い固定幅
            wrapper.style.backgroundColor = '#fff';
            wrapper.style.padding = '40px';
            wrapper.style.fontFamily = 'sans-serif';
            document.body.appendChild(wrapper);
            const match = await db.matchInfo.get(currentMatchId);
            const title = document.createElement('h1');
            title.textContent = `V-Metrics Report`;
            title.style.color = '#00478c';
            title.style.borderBottom = '2px solid #00478c';
            wrapper.appendChild(title);
            const meta = document.createElement('p');
            meta.innerHTML = `Date: <b>${match?.match_date}</b> | Opponent: <b>${match?.opponent_name}</b>`;
            wrapper.appendChild(meta);
            for (const id of this.state.selectedShareOptions) {
                const section = document.createElement('div');
                section.style.marginTop = '30px';
                section.style.pageBreakInside = 'avoid'; // PDF改ページ対策
                let sourceEl = null;
                let sectionTitle = "";
                if (id === 'overall') {
                    sectionTitle = "全体分析";
                    sourceEl = document.querySelector('#overall-analysis .overall-container');
                } else if (id === 'spiker_atk') {
                    sectionTitle = "スパイカー成績 (攻撃)";
                    // テーブルだけ取得 (h3タグの次にあるdiv)
                    const h3 = Array.from(document.querySelectorAll('#spiker-table-view h3')).find(el => el.textContent.includes('攻撃'));
                    if(h3) sourceEl = h3.nextElementSibling;
                } else if (id === 'spiker_srv') {
                    sectionTitle = "スパイカー成績 (サーブ)";
                    const h3 = Array.from(document.querySelectorAll('#spiker-table-view h3')).find(el => el.textContent.includes('サーブ'));
                    if(h3) sourceEl = h3.nextElementSibling;
                } else if (id === 'setter_dist') {
                    sectionTitle = "セッター配球";
                    sourceEl = document.querySelector('#setter-analysis .chart-container');
                }
                if (sourceEl) {
                    const h2 = document.createElement('h2');
                    h2.textContent = sectionTitle;
                    h2.style.background = '#f0f0f0';
                    h2.style.padding = '5px 10px';
                    h2.style.fontSize = '1.2rem';
                    section.appendChild(h2);
                    const clone = sourceEl.cloneNode(true);
                    const originalCanvases = sourceEl.querySelectorAll('canvas');
                    const clonedCanvases = clone.querySelectorAll('canvas');
                    originalCanvases.forEach((orig, index) => {
                        const dest = clonedCanvases[index];
                        if (dest) {
                            const img = document.createElement('img');
                            img.src = orig.toDataURL("image/png");
                            img.style.width = '100%';
                            img.style.maxWidth = '100%'; // 幅合わせ
                            dest.parentNode.replaceChild(img, dest);
                        }
                    });
                    section.appendChild(clone);
                    wrapper.appendChild(section);
                }
            }
            const canvas = await html2canvas(wrapper, {
                scale: 2, // 高画質
                useCORS: true,
                logging: false
            });
            if (format === 'png') {
                const link = document.createElement('a');
                link.download = `VMetrics_Report_${Date.now()}.png`;
                link.href = canvas.toDataURL();
                link.click();
            } else {
                const { jsPDF } = window.jspdf;
                const pdf = new jsPDF('p', 'mm', 'a4');
                const imgData = canvas.toDataURL('image/png');
                const imgWidth = 210; // A4幅(mm)
                const pageHeight = 295; 
                const imgHeight = canvas.height * imgWidth / canvas.width;
                let heightLeft = imgHeight;
                let position = 0;
                pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
                heightLeft -= pageHeight;
                while (heightLeft >= 0) {
                    position = heightLeft - imgHeight;
                    pdf.addPage();
                    pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight);
                    heightLeft -= pageHeight;
                }
                pdf.save(`VMetrics_Report_${Date.now()}.pdf`);
            }
            document.body.removeChild(wrapper);
            UIManager.showFeedback("レポートを出力しました");
        } catch (e) {
            console.error(e);
            UIManager.showFeedback("出力に失敗しました");
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    },
};
const TimeoutManager = {
    dom: {},
    currentLogs: [], // 計算用にデータを保持
    isSetEndMode: false,
    init() {
        const d = document;
        this.dom = {
            screen: d.getElementById('timeout-screen'),
            mainView: d.getElementById('to-main-view'),
            detailView: d.getElementById('to-detail-view'),
            detailTitle: d.getElementById('to-detail-title'),
            detailContent: d.getElementById('to-detail-content'),
            setNum: d.getElementById('to-set-num'),
            ourScore: d.getElementById('to-our-score'),
            oppScore: d.getElementById('to-opp-score'),
            btnAction: d.getElementById('btn-to-action'), // 閉じる or 次へ
            killRate: d.getElementById('to-kill-rate'),
            effRate: d.getElementById('to-eff-rate'),
            barKill: d.getElementById('bar-kill'),
            soRate: d.getElementById('to-so-rate'),
            soCount: d.getElementById('to-so-count'),
            soWinCount: d.getElementById('to-so-win-count'),
            barSo: d.getElementById('bar-so'),
            brRate: d.getElementById('to-br-rate'),
            brCount: d.getElementById('to-br-count'),
            brWinCount: d.getElementById('to-br-win-count'),
            barBr: d.getElementById('bar-br'),
            totalPoints: d.getElementById('to-total-points'),
            pSpike: d.getElementById('p-spike'),
            pServe: d.getElementById('p-serve'),
            pBlock: d.getElementById('p-block'),
            pOppErr: d.getElementById('p-opp-err'),
            pSelfRate: d.getElementById('p-self-rate'),
            totalErrors: d.getElementById('to-total-errors'),
            eSpike: d.getElementById('e-spike'),
            eServe: d.getElementById('e-serve'),
            eRece: d.getElementById('e-rece'),
            eOther: d.getElementById('e-other'),
            eOppKill: d.getElementById('e-opp-kill'),
            topScorers: d.getElementById('to-top-scorers')
        };
        if (this.dom.btnAction) {
            this.dom.btnAction.addEventListener('click', () => this.handleAction());
        }
    },
    open(isSetEnd = false) {
        if (!this.dom.screen) this.init(); 
        this.init(); // 再取得
        this.isSetEndMode = isSetEnd;
        if (isSetEnd) {
            this.dom.btnAction.textContent = "次のセットへ";
            this.dom.btnAction.classList.add('btn-next-set');
        } else {
            this.dom.btnAction.textContent = "閉じる";
            this.dom.btnAction.classList.remove('btn-next-set');
        }
        this.hideDetail(); 
        this.calculateAndRender();
        this.dom.screen.style.display = 'flex';
    },
    handleAction() {
        this.dom.screen.style.display = 'none';
        if (this.isSetEndMode) {
            setTimeout(() => {
                const btnNext = document.getElementById('btn-next-set'); // 既存のボタン
                if(btnNext) btnNext.click(); // 既存のロジックを流用
            }, 100);
        }
    },
    showDetail(type) {
        this.dom.mainView.style.display = 'none';
        this.dom.detailView.style.display = 'flex';
        
        if (type === 'attack') {
            this.dom.detailTitle.textContent = "アタック詳細 (選手別)";
            this.renderAttackDetail();
        } else if (type === 'rotation') {
            this.dom.detailTitle.textContent = "ローテーション別 SO / Break";
            this.renderRotationDetail();
        }
    },
    hideDetail() {
        this.dom.detailView.style.display = 'none';
        this.dom.mainView.style.display = 'grid';
    },
    async calculateAndRender() {
        this.currentLogs = await db.rallyLog
            .where('match_id').equals(currentMatchId)
            .filter(r => r.set_number === currentSetNumber)
            .toArray();
        const logs = this.currentLogs;
        let spikes = 0, kills = 0, errors = 0;
        let soOpp = 0, soWin = 0;
        let brOpp = 0, brWin = 0;
        const pts = { S:0, SA:0, B:0, OP:0 }; 
        const errs = { S:0, SV:0, R:0, O:0 };
        let oppKillCount = 0;
        const playerScores = {}; 
        logs.forEach(row => {
            if (row.spiker_id) {
                if (!playerScores[row.spiker_id]) {
                    playerScores[row.spiker_id] = { total: 0, S: 0, B: 0, SA: 0, kills: 0, spikes: 0 };
                }
            }
            const isSpike = ['SPIKE','LEFT','RIGHT','BACK_ATTACK','A_QUICK','B_QUICK','C_QUICK','A_SEMI'].includes(row.attack_type);
            if (isSpike && row.spiker_id) {
                spikes++;
                playerScores[row.spiker_id].spikes++;
                if (row.result === 'KILL') {
                    kills++;
                    playerScores[row.spiker_id].kills++; // 決定率計算用
                }
                if (row.result === 'FAULT' || row.result === 'BLOCKED') errors++;
            }
            const isSideOutChance = (row.pass_position && row.pass_position !== 'UNKNOWN') 
                                 || (row.reason === 'SA' && row.result === 'FAULT');
            let isOurPoint = false;
            if (['S','B','SA','OP'].includes(row.reason)) isOurPoint = true;
            else if (row.result === 'KILL' && !['MS','BS','SV','RE','EH','F'].includes(row.reason)) isOurPoint = true;
            if (isSideOutChance) {
                soOpp++;
                if (isOurPoint) soWin++;
            } else {
                brOpp++;
                if (isOurPoint) brWin++;
            }
            if (isOurPoint) {
                if (['S','B','SA'].includes(row.reason)) {
                    if(row.reason === 'S') pts.S++;
                    else if(row.reason === 'SA') pts.SA++;
                    else if(row.reason === 'B') pts.B++;
                    if (row.spiker_id) {
                        if (!playerScores[row.spiker_id]) playerScores[row.spiker_id] = { total: 0, S: 0, B: 0, SA: 0, kills: 0, spikes: 0 };
                        playerScores[row.spiker_id].total++; // 合計点アップ
                        if(row.reason === 'S') playerScores[row.spiker_id].S++;
                        if(row.reason === 'SA') playerScores[row.spiker_id].SA++;
                        if(row.reason === 'B') playerScores[row.spiker_id].B++;
                    }
                } else {
                    pts.OP++;
                }
            } else {
                if (row.reason === 'MS' || row.reason === 'BS') errs.S++;
                else if (row.reason === 'SV') errs.SV++;
                else if (row.reason === 'RE' || row.reason === 'SA') { errs.R++; if(row.reason === 'SA') oppKillCount++; }
                else if (row.reason === 'S') { oppKillCount++; }
                else errs.O++;
            }
        });
        // --- 描画 (数値反映) ---
        this.dom.setNum.textContent = currentSetNumber;
        this.dom.ourScore.textContent = GameManager.state.ourScore;
        this.dom.oppScore.textContent = GameManager.state.opponentScore;
        const kRate = spikes ? (kills / spikes * 100).toFixed(1) : 0;
        const eRate = spikes ? ((kills - errors) / spikes * 100).toFixed(1) : 0;
        this.dom.killRate.textContent = `${kRate}%`;
        this.dom.effRate.textContent = `${eRate}%`;
        if(this.dom.barKill) this.dom.barKill.style.width = `${Math.min(kRate, 100)}%`;
        const sRate = soOpp ? (soWin / soOpp * 100).toFixed(1) : 0;
        this.dom.soRate.textContent = `${sRate}%`;
        this.dom.soCount.textContent = soOpp;
        if(this.dom.soWinCount) this.dom.soWinCount.textContent = soWin;
        if(this.dom.barSo) this.dom.barSo.style.width = `${Math.min(sRate, 100)}%`;
        const bRate = brOpp ? (brWin / brOpp * 100).toFixed(1) : 0;
        this.dom.brRate.textContent = `${bRate}%`;
        this.dom.brCount.textContent = brOpp;
        if(this.dom.brWinCount) this.dom.brWinCount.textContent = brWin;
        if(this.dom.barBr) this.dom.barBr.style.width = `${Math.min(bRate, 100)}%`;
        const totalGet = pts.S + pts.SA + pts.B + pts.OP;
        const selfGet = pts.S + pts.SA + pts.B;
        this.dom.totalPoints.textContent = totalGet;
        this.dom.pSpike.textContent = pts.S;
        this.dom.pServe.textContent = pts.SA;
        this.dom.pBlock.textContent = pts.B;
        this.dom.pOppErr.textContent = pts.OP;
        this.dom.pSelfRate.textContent = totalGet ? Math.round(selfGet/totalGet*100) + '%' : '0%';
        const totalLost = errs.S + errs.SV + errs.R + errs.O + oppKillCount; 
        this.dom.totalErrors.textContent = totalLost;
        this.dom.eSpike.textContent = errs.S;
        this.dom.eServe.textContent = errs.SV;
        this.dom.eRece.textContent = errs.R;
        this.dom.eOther.textContent = errs.O;
        this.dom.eOppKill.textContent = oppKillCount;
        this.dom.topScorers.innerHTML = '';
        const sortedPlayers = Object.entries(playerScores)
            .sort((a, b) => b[1].total - a[1].total) // 合計得点順
            .slice(0, 5);
        if (sortedPlayers.length === 0) {
            this.dom.topScorers.innerHTML = '<li style="justify-content:center; color:#555;">データなし</li>';
        } else {
            sortedPlayers.forEach(([pid, stats]) => {
                if (stats.total === 0) return;
                const p = testPlayerList[pid] || { name: 'Unknown', jersey: '?' };
                const li = document.createElement('li');
                const breakdown = [];
                if(stats.S > 0) breakdown.push(`S:${stats.S}`);
                if(stats.B > 0) breakdown.push(`B:${stats.B}`);
                if(stats.SA > 0) breakdown.push(`A:${stats.SA}`);
                
                li.innerHTML = `
                    <span>[${p.jersey}] ${p.name}</span>
                    <div>
                        <span class="scorer-val">${stats.total}点</span>
                        <span style="font-size:0.75rem; color:#888; margin-left:5px;">(${breakdown.join(', ')})</span>
                    </div>
                `;
                this.dom.topScorers.appendChild(li);
            });
        }
    },
    // --- 詳細レンダリング: アタック ---
    renderAttackDetail() {
        const stats = {}; // { pid: { spikes, kills, errors } }
        this.currentLogs.forEach(row => {
            const isSpike = ['SPIKE','LEFT','RIGHT','BACK_ATTACK','A_QUICK','B_QUICK','C_QUICK','A_SEMI'].includes(row.attack_type);
            if (isSpike && row.spiker_id) {
                if (!stats[row.spiker_id]) stats[row.spiker_id] = { spikes:0, kills:0, errors:0 };
                stats[row.spiker_id].spikes++;
                if (row.result === 'KILL') stats[row.spiker_id].kills++;
                if (row.result === 'FAULT' || row.result === 'BLOCKED') stats[row.spiker_id].errors++;
            }
        });
        const sorted = Object.entries(stats).sort((a,b) => b[1].spikes - a[1].spikes);
        let html = `
            <table class="dark-table">
                <thead><tr><th>選手</th><th>打数</th><th>得点</th><th>失点</th><th>決定率</th><th>効果率</th></tr></thead>
                <tbody>
        `;
        sorted.forEach(([pid, s]) => {
            const p = testPlayerList[pid] || { name: 'Unknown', jersey: '?' };
            const kRate = (s.kills / s.spikes * 100).toFixed(1);
            const eRate = ((s.kills - s.errors) / s.spikes * 100).toFixed(1);
            html += `<tr>
                <td style="font-weight:bold; color:#f39c12;">[${p.jersey}] ${p.name}</td>
                <td>${s.spikes}</td>
                <td style="color:#2ECC71;">${s.kills}</td>
                <td style="color:#E74C3C;">${s.errors}</td>
                <td style="font-weight:bold;">${kRate}%</td>
                <td style="color:#aaa;">${eRate}%</td>
            </tr>`;
        });
        html += '</tbody></table>';
        this.dom.detailContent.innerHTML = html;
    },
    // --- 詳細レンダリング: ローテーション ---
    renderRotationDetail() {
        const rotStats = {};
        for(let i=1; i<=6; i++) rotStats[i] = { soTotal:0, soWin:0, brTotal:0, brWin:0 };
        this.currentLogs.forEach(row => {
            const rot = row.rotation_number || 1;
            if(!rotStats[rot]) rotStats[rot] = { soTotal:0, soWin:0, brTotal:0, brWin:0 }; // 安全策

            const isSideOutChance = (row.pass_position && row.pass_position !== 'UNKNOWN') || (row.reason === 'SA' && row.result === 'FAULT');
            let isOurPoint = false;
            if (['S','B','SA','OP'].includes(row.reason)) isOurPoint = true;
            else if (row.result === 'KILL' && !['MS','BS','SV','RE','EH','F'].includes(row.reason)) isOurPoint = true;

            if (isSideOutChance) {
                rotStats[rot].soTotal++;
                if (isOurPoint) rotStats[rot].soWin++;
            } else {
                rotStats[rot].brTotal++;
                if (isOurPoint) rotStats[rot].brWin++;
            }
        });
        let html = `
            <table class="dark-table">
                <thead><tr><th>Rot</th><th>S.O.率</th><th>成功/機会</th><th>Break率</th><th>成功/機会</th></tr></thead>
                <tbody>
        `;
        for(let i=1; i<=6; i++) {
            const s = rotStats[i];
            const soRate = s.soTotal ? (s.soWin / s.soTotal * 100).toFixed(0) : '-';
            const brRate = s.brTotal ? (s.brWin / s.brTotal * 100).toFixed(0) : '-';
            const soColor = (s.soTotal && (s.soWin/s.soTotal < 0.3)) ? '#E74C3C' : '#2ECC71';

            html += `<tr>
                <td style="font-weight:bold; color:#fff;">Rot ${i}</td>
                <td style="font-weight:bold; color:${soColor}; font-size:1.1em;">${soRate}%</td>
                <td style="color:#888;">${s.soWin} / ${s.soTotal}</td>
                <td style="font-weight:bold; color:#E67E22; font-size:1.1em;">${brRate}%</td>
                <td style="color:#888;">${s.brWin} / ${s.brTotal}</td>
            </tr>`;
        }
        html += '</tbody></table>';
        this.dom.detailContent.innerHTML = html;
    }
};
const DataManager = {
    async exportAllData() {
        try {
            const rallyLogs = await db.rallyLog.toArray();
            const matchInfos = await db.matchInfo.toArray();
            const players = await db.playerList.toArray();
            const summaries = await db.setSummary.toArray();
            const matchMap = {};
            matchInfos.forEach(m => matchMap[m.match_id] = m);
            const playerMap = {};
            players.forEach(p => playerMap[p.player_id] = p.player_name);
            const summaryMap = {}; // key: matchId_setNum
            summaries.forEach(s => summaryMap[`${s.match_id}_${s.set_number}`] = s);
            let csvContent = "MatchDate,Competition,Opponent,Set,RallyID,Score(Our-Opp),Rotation,Setter,Player,Action,Result,PassQ,TossArea,TossDist,TossLen,TossHeight\n";
            rallyLogs.sort((a, b) => {
                if (a.match_id !== b.match_id) return a.match_id - b.match_id;
                if (a.set_number !== b.set_number) return a.set_number - b.set_number;
                return a.play_id - b.play_id;
            });
            let currentMatchSet = "";
            let s1 = 0, s2 = 0;
            rallyLogs.forEach(log => {
                const msKey = `${log.match_id}_${log.set_number}`;
                if (currentMatchSet !== msKey) {
                    s1 = 0; s2 = 0;
                    currentMatchSet = msKey;
                }
                const pt = GameManager.calcPointDelta(log);
                if (pt === 1) s1++;
                if (pt === -1) s2++;
                const match = matchMap[log.match_id] || { match_date: '-', competition_name: '-', opponent_name: '-' };
                const playerName = playerMap[log.spiker_id] || log.spiker_id || '-';
                const setterName = playerMap[log.setter_id] || '-';
                const row = [
                    match.match_date,
                    `"${match.competition_name}"`,
                    `"${match.opponent_name}"`,
                    log.set_number,
                    log.rally_id,
                    `"${s1}-${s2}"`, // スコア
                    log.rotation_number,
                    `"${setterName}"`,
                    `"${playerName}"`,
                    log.attack_type || '-',
                    log.result || '-',
                    log.pass_position || '-',
                    log.toss_area || '-',
                    log.toss_distance || '-',
                    log.toss_length || '-',
                    log.toss_height || '-'
                ].join(",");

                csvContent += row + "\n";
            });
            const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            const now = new Date();
            const timestamp = now.getFullYear() +
                String(now.getMonth() + 1).padStart(2, '0') +
                String(now.getDate()).padStart(2, '0');
            link.setAttribute("download", `VMetrics_Data_${timestamp}.csv`);
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            UIManager.showFeedback("CSV出力を開始しました");
        } catch (err) {
            console.error("Export Error:", err);
            UIManager.showFeedback("エクスポートに失敗しました: " + err);
        }
    },
    async deleteAllData() {
        if (!confirm("【警告】\n本当に全てのデータを削除しますか？\nこの操作は取り消せません！")) return;
        if (!confirm("本当に削除してよろしいですか？")) return;
        try {
            await db.delete(); // データベースごと削除
            UIManager.showFeedback("データを削除しました。アプリをリロードします。");
            window.location.reload();
        } catch (e) {
            UIManager.showFeedback("削除に失敗しました: " + e);
        }
    },
    async importCsvData(file) {
        const statusEl = uiElements.importStatus;
        statusEl.style.display = 'block';
        statusEl.textContent = "読み込み中...";
        const reader = new FileReader();
        reader.onload = async (e) => {
            const text = e.target.result;
            try {
                await this.processCsvText(text);
                statusEl.textContent = "インポート完了！";
                UIManager.showFeedback("データのインポートが完了しました。");
                setTimeout(() => statusEl.style.display = 'none', 3000);
            } catch (err) {
                console.error(err);
                statusEl.textContent = "エラーが発生しました";
                UIManager.showFeedback("インポートに失敗しました: " + err.message);
            }
        };
        reader.readAsText(file);
    },
    async processCsvText(text) {
        const lines = text.split(/\r\n|\n/);
        const headers = lines[0].split(','); 
        if (!headers.includes('MatchDate') || !headers.includes('RallyID')) {
            throw new Error("CSVの形式が正しくありません (V-Metrics形式ではありません)");
        }
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            const cols = lines[i].match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) || [];
            const d = cols.map(c => c.replace(/^"|"$/g, '').replace(/,$/, '')); 
            rows.push({
                date: d[0], comp: d[1], opp: d[2], set: Number(d[3]), rallyId: Number(d[4]),
                rot: Number(d[6]), setterName: d[7], playerName: d[8],
                action: d[9], result: d[10], pass: d[11], 
                tossA: d[12], tossD: d[13], tossL: d[14], tossH: d[15]
            });
        }
        const matchGroups = {};
        rows.forEach(r => {
            const key = `${r.date}_${r.comp}_${r.opp}`; // 一意なキー
            if (!matchGroups[key]) matchGroups[key] = [];
            matchGroups[key].push(r);
        });
        for (const key of Object.keys(matchGroups)) {
            const groupRows = matchGroups[key];
            const first = groupRows[0];
            const existingMatch = await db.matchInfo
                .filter(m => 
                    m.match_date === first.date && 
                    m.competition_name === first.comp && 
                    m.opponent_name === first.opp
                )
                .first();
            let shouldImport = true;
            let deleteTargetId = null;
            if (existingMatch) {
                const msg = `重複する試合が見つかりました。\n\n日付: ${first.date}\n大会: ${first.comp}\n相手: ${first.opp}\n\nこの試合データを「上書き」しますか？\n(キャンセルを押すと、この試合のインポートをスキップします)`;
                if (confirm(msg)) {
                    deleteTargetId = existingMatch.match_id;
                } else {
                    shouldImport = false;
                    console.log(`スキップしました: ${first.date} vs ${first.opp}`);
                }
            }
            if (!shouldImport) continue; // 次の試合へ
            await db.transaction('rw', db.matchInfo, db.setRoster, db.setSummary, db.rallyLog, db.playerList, async () => {
                if (deleteTargetId !== null) {
                    await db.matchInfo.delete(deleteTargetId);
                    await db.setRoster.where('match_id').equals(deleteTargetId).delete();
                    await db.setSummary.where('match_id').equals(deleteTargetId).delete();
                    await db.rallyLog.where('match_id').equals(deleteTargetId).delete();
                    console.log(`古いデータを削除しました (MatchID: ${deleteTargetId})`);
                }
                const matchId = await db.matchInfo.add({
                    match_date: first.date,
                    competition_name: first.comp,
                    opponent_name: first.opp,
                    match_type: 'imported' 
                });
                const setNumbers = [...new Set(groupRows.map(r => r.set))];
                for (const setNum of setNumbers) {
                    const setRows = groupRows.filter(r => r.set === setNum);
                    await db.setSummary.add({
                        match_id: matchId,
                        set_number: setNum,
                        our_final_score: 0, 
                        opponent_final_score: 0,
                        set_result: null
                    });
                    for (const r of setRows) {
                        const spikerId = await this.resolvePlayerId(r.playerName);
                        const setterId = await this.resolvePlayerId(r.setterName);
                        await db.rallyLog.add({
                            match_id: matchId,
                            set_number: r.set,
                            rally_id: r.rallyId,
                            rotation_number: r.rot,
                            setter_id: setterId,
                            spiker_id: spikerId,
                            attack_type: r.action === '-' ? null : r.action,
                            result: r.result === '-' ? null : r.result,
                            pass_position: r.pass === '-' ? null : r.pass,
                            toss_area: r.tossA === '-' ? null : r.tossA,
                            toss_distance: r.tossD === '-' ? null : r.tossD,
                            toss_length: r.tossL === '-' ? null : r.tossL,
                            toss_height: r.tossH === '-' ? null : r.tossH
                        });
                    }
                }
            });
        }
    },
    async resolvePlayerId(name) {
        if (!name || name === '-' || name === 'none') return null;
        const existing = await db.playerList.where('player_name').equals(name).first();
        if (existing) {
            return existing.player_id;
        } else {
            const newId = 'p_imp_' + Date.now() + Math.floor(Math.random()*1000);
            await db.playerList.add({
                player_id: newId,
                player_name: name,
                current_jersey_number: 0,
                position: 'OH'
            });
            return newId;
        }
    },
    async renderExplorer() {
        const container = document.getElementById('data-explorer');
        if (!container) return;
        container.innerHTML = '<p style="text-align:center;">読み込み中...</p>';
        try {
            const matches = await db.matchInfo.toArray();
            const summaries = await db.setSummary.toArray();
            if (matches.length === 0) {
                container.innerHTML = '<p style="text-align:center; color:#888;">データがありません</p>';
                return;
            }
            container.innerHTML = '';
            matches.reverse().forEach(m => {
                const mDiv = document.createElement('div');
                mDiv.className = 'match-item';
                const sets = summaries.filter(s => s.match_id === m.match_id).sort((a,b) => a.set_number - b.set_number);
                mDiv.innerHTML = `
                    <div class="match-header" onclick="this.nextElementSibling.classList.toggle('open')">
                        <span>${m.match_date} vs ${m.opponent_name}</span>
                        <span style="font-size:0.8em; color:#aaa;">▼</span>
                    </div>
                    <div class="set-list">
                        </div>
                `;
                const setListContainer = mDiv.querySelector('.set-list');
                if (sets.length === 0) {
                    setListContainer.innerHTML = '<div class="set-item">セットデータなし</div>';
                } else {
                    sets.forEach(s => {
                        const sDiv = document.createElement('div');
                        sDiv.className = 'set-item';
                        sDiv.innerHTML = `
                            <span>第${s.set_number}セット (${s.our_final_score}-${s.opponent_final_score})</span>
                            <div class="set-actions">
                                <button class="action-btn btn-set-edit">修正</button>
                                <button class="action-btn btn-set-delete">削除</button>
                            </div>
                        `;
                        sDiv.querySelector('.btn-set-edit').addEventListener('click', () => {
                            DataManager.openSetForEditing(m.match_id, s.set_number);
                        });
                        sDiv.querySelector('.btn-set-delete').addEventListener('click', () => {
                            DataManager.deleteSetData(m.match_id, s.set_number);
                        });
                        setListContainer.appendChild(sDiv);
                    });
                }
                container.appendChild(mDiv);
            });
        } catch (e) {
            console.error(e);
            container.innerHTML = '<p>エラーが発生しました</p>';
        }
    },
    openSetForEditing(matchId, setNum) {
        if (currentMatchId !== matchId) {
            if (!confirm("現在選択中の試合とは別の試合です。\n修正モードを開きますか？\n(現在の入力内容はクリアされませんが、表示が切り替わります)")) {
                return;
            }
        }
        const tempMatchId = currentMatchId;
        const tempSetNum = currentSetNumber;
        currentMatchId = matchId;
        currentSetNumber = setNum;
        EditManager.openLogModal();
    },
    async deleteSetData(matchId, setNum) {
        if (!confirm(`第${setNum}セットのデータを削除しますか？\nこの操作は取り消せません。`)) return;       
        try {
            await db.transaction('rw', db.matchInfo, db.setRoster, db.setSummary, db.rallyLog, async () => {
                await db.rallyLog.where('match_id').equals(matchId)
                    .filter(r => r.set_number === setNum).delete();
                await db.setSummary.where('[match_id+set_number]').equals([matchId, setNum]).delete();
                await db.setRoster.where('[match_id+set_number]').equals([matchId, setNum]).delete();
                const remainingSummaries = await db.setSummary.where('match_id').equals(matchId).toArray();
                if (remainingSummaries.length === 0) {
                    await db.matchInfo.delete(matchId);
                    UIManager.showFeedback("全てのセットが削除されたため、試合記録自体を削除しました。");
                    if (currentMatchId === matchId) {
                        GameManager.resetMatch(1, 1, null, true);
                    }
                } else {
                    remainingSummaries.sort((a, b) => a.set_number - b.set_number);
                    let shiftOccurred = false;
                    for (const summary of remainingSummaries) {
                        if (summary.set_number > setNum) {
                            const oldSetNum = summary.set_number;
                            const newSetNum = oldSetNum - 1; // 1つ前にずらす
                            await db.rallyLog.where('match_id').equals(matchId)
                                .filter(r => r.set_number === oldSetNum)
                                .modify({ set_number: newSetNum });
                            await db.setSummary.where('[match_id+set_number]').equals([matchId, oldSetNum]).delete();
                            summary.set_number = newSetNum;
                            await db.setSummary.add(summary);
                            const rosters = await db.setRoster.where('[match_id+set_number]').equals([matchId, oldSetNum]).toArray();
                            await db.setRoster.where('[match_id+set_number]').equals([matchId, oldSetNum]).delete();
                            rosters.forEach(r => {
                                r.set_number = newSetNum;
                                delete r.set_roster_id; // IDは自動採番させるため削除
                            });
                            await db.setRoster.bulkAdd(rosters);
                            shiftOccurred = true;
                        }
                    }
                    if (shiftOccurred) {
                        UIManager.showFeedback("削除しました。\n以降のセット番号を自動的に繰り上げました。");
                    } else {
                        UIManager.showFeedback("削除しました。");
                    }
                }
            });
            this.renderExplorer(); 
        } catch (e) {
            console.error(e);
            UIManager.showFeedback("削除処理中にエラーが発生しました");
        }
    },
    async exportBackupJSON() {
        try {
            const data = {
                version: 1,
                timestamp: new Date().toISOString(),
                playerList: await db.playerList.toArray(),
                matchInfo: await db.matchInfo.toArray(),
                setRoster: await db.setRoster.toArray(),
                rallyLog: await db.rallyLog.toArray(),
                setSummary: await db.setSummary.toArray(),
                lineupPatterns: await db.lineupPatterns.toArray()
            };
            const jsonStr = JSON.stringify(data, null, 2);
            const blob = new Blob([jsonStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
            link.href = url;
            link.download = `VMetrics_Backup_${dateStr}.json`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            UIManager.showFeedback("バックアップファイルを保存しました。");
        } catch (e) {
            console.error(e);
            UIManager.showFeedback("バックアップ作成に失敗しました。");
        }
    },
    async importBackupJSON(file) {
        if (!confirm("【警告】\nバックアップを復元すると、現在のデータは全て削除され、上書きされます。\nよろしいですか？")) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const data = JSON.parse(e.target.result);
                if (!data.version || !data.playerList) {
                    throw new Error("不正なファイル形式です");
                }
                await db.transaction('rw', db.playerList, db.matchInfo, db.setRoster, db.rallyLog, db.setSummary, db.lineupPatterns, async () => {
                    await db.playerList.clear();
                    await db.matchInfo.clear();
                    await db.setRoster.clear();
                    await db.rallyLog.clear();
                    await db.setSummary.clear();
                    await db.lineupPatterns.clear();
                    await db.playerList.bulkAdd(data.playerList);
                    await db.matchInfo.bulkAdd(data.matchInfo);
                    await db.setRoster.bulkAdd(data.setRoster);
                    await db.rallyLog.bulkAdd(data.rallyLog);
                    await db.setSummary.bulkAdd(data.setSummary);
                    if (data.lineupPatterns) await db.lineupPatterns.bulkAdd(data.lineupPatterns);
                });
                UIManager.showFeedback("復元が完了しました。アプリをリロードします。");
                setTimeout(() => window.location.reload(), 2000);
            } catch (err) {
                console.error(err);
                UIManager.showFeedback("復元に失敗しました: " + err.message);
            }
        };
        reader.readAsText(file);
    }
};

async function initializeMasterData() {
    try {
        const oppData = await db.appConfig.get('master_opponents');
        if (!oppData) {
            await db.appConfig.put({ key: 'master_opponents', data: INITIAL_OPPONENT_DATA });
            console.log("対戦校マスターデータを初期化しました");
        }
        const compData = await db.appConfig.get('master_competitions');
        if (!compData) {
            await db.appConfig.put({ key: 'master_competitions', data: INITIAL_COMPETITION_DATA });
            console.log("大会マスターデータを初期化しました");
        }
    } catch (e) {
        console.error("マスターデータ初期化エラー", e);
    }
}
const TARGET_LEAGUE_FOLDERS = ['関東医歯薬'];
const InputSelectorManager = {
    dom: {},
    targetInput: null,
    currentKey: null, 
    currentData: null, 
    currentPath: [],   
    isEditMode: false, 
    init() {
        this.dom = {
            modal: document.getElementById('selection-modal'),
            title: document.getElementById('selection-title'),
            container: document.getElementById('selection-list-container'),
            btnClose: document.getElementById('btn-selection-close'),
            btnBack: document.getElementById('btn-selection-back'),
            header: document.querySelector('.selection-modal-header')
        };
        if (!document.getElementById('btn-selection-edit')) {
            const editBtn = document.createElement('button');
            editBtn.id = 'btn-selection-edit';
            editBtn.className = 'selection-nav-btn';
            editBtn.textContent = '編集';
            editBtn.style.marginRight = '10px';
            editBtn.onclick = () => this.toggleEditMode();
            this.dom.btnClose.parentNode.insertBefore(editBtn, this.dom.btnClose);
            this.dom.btnEdit = editBtn;
        }
        if (this.dom.btnClose) this.dom.btnClose.addEventListener('click', () => this.close());
        if (this.dom.btnBack) this.dom.btnBack.addEventListener('click', () => this.goBack());
        if (uiElements.setupCompetition) {
            uiElements.setupCompetition.addEventListener('click', () => this.open('master_competitions', uiElements.setupCompetition));
        }
        if (uiElements.setupOpponent) {
            uiElements.setupOpponent.addEventListener('click', () => this.open('master_opponents', uiElements.setupOpponent));
        }
    },
    async openForEdit(key) {
        await this.open(key, null);
        this.isEditMode = true;
        this.updateEditButton();
        this.render();
    },
    async open(key, inputElement) {
        this.targetInput = inputElement;
        this.currentKey = key;
        this.currentPath = []; 
        this.isEditMode = false;
        this.movingData = null;
        this.updateEditButton();
        
        const record = await db.appConfig.get(key);
        this.currentData = record ? record.data : { name: 'root', children: [] };

        this.dom.modal.style.display = 'flex';
        this.render();
    },
    close() {
        this.dom.modal.style.display = 'none';
        this.movingData = null;
    },
    async saveData() {
        await db.appConfig.put({ key: this.currentKey, data: this.currentData });
    },
    getCurrentNode() {
        return this.getNodeByPath(this.currentPath);
    },
    getParentNode() {
        if (this.currentPath.length === 0) return null;
        const parentPath = this.currentPath.slice(0, -1);
        return this.getNodeByPath(parentPath);
    },
    getNodeByPath(path) {
        let node = this.currentData;
        for (const index of path) {
            if (node && node.children) {
                node = node.children[index];
            }
        }
        return node;
    },
    goBack() {
        if (this.currentPath.length > 0) {
            this.currentPath.pop();
            this.render();
        }
    },
    toggleEditMode() {
        this.isEditMode = !this.isEditMode;
        this.movingData = null;
        this.updateEditButton();
        this.render();
    },
    updateEditButton() {
        if(this.dom.btnEdit) {
            this.dom.btnEdit.textContent = this.isEditMode ? '完了' : '編集';
            this.dom.btnEdit.style.backgroundColor = this.isEditMode ? 'var(--orange)' : '';
        }
    },
    async moveLeagueItem(itemIndex, direction) {
        const parentNode = this.getParentNode();
        const currentFolderIndex = this.currentPath[this.currentPath.length - 1];
        const targetFolderIndex = currentFolderIndex + direction;
        if (!parentNode.children[targetFolderIndex]) return;
        const currentFolder = this.getCurrentNode();
        const targetFolder = parentNode.children[targetFolderIndex];
        const [item] = currentFolder.children.splice(itemIndex, 1);
        if (!targetFolder.children) targetFolder.children = [];
        targetFolder.children.push(item);
        await this.saveData();   
        const actionName = direction === -1 ? "昇格" : "降格";
        UIManager.showFeedback(`「${targetFolder.name}」へ${actionName}しました`);
        this.render();
    },
    async render() {
        const container = this.dom.container;
        container.innerHTML = '';
        const currentNode = this.getCurrentNode();
        const parentNode = this.getParentNode();
        const isLeagueContext = parentNode && TARGET_LEAGUE_FOLDERS.includes(parentNode.name);
        const currentFolderIndex = this.currentPath.length > 0 ? this.currentPath[this.currentPath.length - 1] : -1;
        if (this.currentPath.length === 0) {
            this.dom.title.textContent = (this.currentKey === 'master_competitions') ? '大会名マスター' : '対戦校マスター';
            this.dom.btnBack.classList.add('hidden-btn');
            if (!this.isEditMode && this.targetInput) await this.renderHistory(container);
        } else {
            this.dom.title.textContent = currentNode.name;
            this.dom.btnBack.classList.remove('hidden-btn');
        }
        if (this.isEditMode && this.movingData) {
            const moveBanner = document.createElement('div');
            moveBanner.className = 'move-banner';
            moveBanner.innerHTML = `
                <div style="margin-bottom:8px;"><strong>「${this.movingData.name}」</strong>を移動中...</div>
                <div style="display:flex; gap:10px; justify-content:center;">
                    <button class="action-btn" style="background:var(--navy); flex:1;" onclick="InputSelectorManager.executeMove()">ここに移動</button>
                    <button class="action-btn" style="background:#999; width:80px;" onclick="InputSelectorManager.cancelMove()">中止</button>
                </div>
            `;
            container.appendChild(moveBanner);
        }
        else if (this.isEditMode) {
            const addArea = document.createElement('div');
            addArea.style.padding = '10px';
            addArea.style.textAlign = 'center';
            addArea.innerHTML = `
                <button class="action-btn mini" onclick="InputSelectorManager.addItem(true)">+ フォルダ</button>
                <button class="action-btn mini" onclick="InputSelectorManager.addItem(false)">+ 項目</button>
            `;
            container.appendChild(addArea);
        }
        if (currentNode.children && currentNode.children.length > 0) {
            currentNode.children.forEach((child, index) => {
                const div = document.createElement('div');
                div.className = 'selection-item';
                if (child.type === 'folder') div.classList.add('is-category');
                const nameSpan = document.createElement('span');
                nameSpan.textContent = child.name;
                nameSpan.style.flex = "1"; // 名前部分を伸縮させる
                div.appendChild(nameSpan);
                if (this.isEditMode) {
                    const actions = document.createElement('div');
                    actions.className = 'item-actions'; // 右寄せCSS用クラス
                    if (isLeagueContext && child.type === 'item') {
                        const promoteBtn = document.createElement('button');
                        promoteBtn.textContent = '昇格';
                        promoteBtn.className = 'league-btn btn-promote';
                        if (currentFolderIndex === 0) promoteBtn.disabled = true;
                        promoteBtn.onclick = (e) => { e.stopPropagation(); this.moveLeagueItem(index, -1); };
                        actions.appendChild(promoteBtn);
                        const demoteBtn = document.createElement('button');
                        demoteBtn.textContent = '降格';
                        demoteBtn.className = 'league-btn btn-demote';
                        if (currentFolderIndex >= parentNode.children.length - 1) demoteBtn.disabled = true;
                        demoteBtn.onclick = (e) => { e.stopPropagation(); this.moveLeagueItem(index, 1); };
                        actions.appendChild(demoteBtn);
                    } 
                    const delBtn = document.createElement('button');
                    delBtn.textContent = '×';
                    delBtn.className = 'btn-delete';
                    delBtn.onclick = (e) => { e.stopPropagation(); this.deleteItem(index); };
                    actions.appendChild(delBtn);
                    div.appendChild(actions);
                    div.onclick = () => {
                        if (child.type === 'folder') {
                            this.currentPath.push(index);
                            this.render();
                        } else if (!this.movingData) {
                            const newName = prompt('名称を変更:', child.name);
                            if(newName && newName.trim()) {
                                child.name = newName;
                                this.saveData();
                                this.render();
                            }
                        }
                    };
                } else {
                    div.onclick = () => {
                        if (child.type === 'folder') {
                            this.currentPath.push(index);
                            this.render();
                        } else {
                            this.selectItem(child.name);
                        }
                    };
                }
                container.appendChild(div);
            });
        } else {
            if (!this.isEditMode && !this.movingData) {
                const empty = document.createElement('div');
                empty.style.padding='20px'; empty.style.textAlign='center'; empty.style.color='#999';
                empty.textContent='項目がありません';
                container.appendChild(empty);
            }
        }
    },
    async renderHistory(container) {
        try {
            const fieldName = (this.currentKey === 'master_competitions') ? 'competition_name' : 'opponent_name';
            const allMatches = await db.matchInfo.orderBy('match_date').reverse().toArray();
            const historySet = new Set();
            const historyList = [];
            allMatches.forEach(m => {
                if (m[fieldName] && !historySet.has(m[fieldName])) {
                    historySet.add(m[fieldName]);
                    historyList.push(m[fieldName]);
                }
            });
            if (historyList.length > 0) {
                const header = document.createElement('div');
                header.className = 'history-header';
                header.textContent = '最近の履歴';
                container.appendChild(header);
                historyList.slice(0, 3).forEach(item => {
                    const div = document.createElement('div');
                    div.className = 'selection-item';
                    div.innerHTML = `<span>${item}</span><span class="history-badge">履歴</span>`;
                    div.onclick = () => this.selectItem(item);
                    container.appendChild(div);
                });
                const sep = document.createElement('div');
                sep.className = 'history-header';
                sep.textContent = 'リストから選択';
                container.appendChild(sep);
            }
        } catch(e) { console.error(e); }
    },
    async addItem(isFolder) {
        const typeName = isFolder ? 'フォルダ' : '項目';
        const name = prompt(`新しい${typeName}の名前を入力:`);
        if (!name || !name.trim()) return;
        const currentNode = this.getCurrentNode();
        if (!currentNode.children) currentNode.children = [];
        currentNode.children.push({
            name: name.trim(),
            type: isFolder ? 'folder' : 'item',
            children: isFolder ? [] : undefined
        });
        await this.saveData();
        this.render();
    },
    async deleteItem(index) {
        if (!confirm('本当に削除しますか？')) return;
        const currentNode = this.getCurrentNode();
        currentNode.children.splice(index, 1);
        await this.saveData();
        this.render();
    },
    selectItem(value) {
        if (this.targetInput) {
            this.targetInput.value = value;
            if (this.currentKey === 'master_competitions') {
                let currentFolder = this.getCurrentNode();
                let folderName = currentFolder ? currentFolder.name : '';
                const pathNames = [];
                let node = this.currentData;
                pathNames.push(node.name);
                for (const index of this.currentPath) {
                    if (node && node.children) {
                        node = node.children[index];
                        pathNames.push(node.name);
                    }
                }
                const matchTypeSelect = document.getElementById('setup-match-type');
                if (matchTypeSelect) {
                    const fullPath = pathNames.join('/');
                    if (fullPath.includes("公式")) {
                        matchTypeSelect.value = "official";
                        console.log("Auto-select: Official");
                    } else if (fullPath.includes("練習")) {
                        matchTypeSelect.value = "practice";
                        console.log("Auto-select: Practice");
                    } else if (fullPath.includes("参考")) {
                        matchTypeSelect.value = "reference"; // 参考試合も練習扱いで良い場合
                    }
                }
            }
        }
        this.close();
    }
};
window.InputSelectorManager = InputSelectorManager;

const ReasonInputManager = {
    REASONS: {
        GAIN: {
            self: [
                { code: 'SA', label: 'サービスエース', action: 'SERVE_ACE' },
                { code: 'B',  label: 'ブロック', action: 'BLOCK' }
            ],
            opp: [
                { code: 'SE', label: 'サーブミス', action: 'OPPONENT_MISS' },
                { code: 'MS', label: 'スパイクミス', action: 'OPPONENT_MISS' },
                { code: 'MB', label: 'ブロックミス', action: 'OPPONENT_MISS' }, // 吸い込み等
                { code: 'MR', label: 'レシーブミス', action: 'OPPONENT_MISS' },
                { code: 'M',  label: '返球ミス',   action: 'OPPONENT_MISS' },
                { code: 'F',  label: '反則',       action: 'OPPONENT_MISS' }
            ]
        },
        LOSS: {
            opp: [
                { code: 'SA', label: '被エース',   action: 'SERVE_ACE' }, // 相手のSA
                { code: 'S',  label: '被スパイク', action: 'SPIKE' }      // 相手のスパイク決定
            ],
            self: [
                { code: 'SE', label: 'サーブミス', action: 'SERVE_MISS' },
                { code: 'MB', label: 'ブロックミス', action: 'BLOCK' }, // 吸い込み等(Touch Out)
                { code: 'MR', label: 'レシーブミス', action: 'PASS' },  // お見合い等
                { code: 'M',  label: '返球ミス',   action: 'DIG' },
                { code: 'F',  label: '反則',       action: 'FOUL' }
            ]
        }
    },
    targetSide: null, // 'our' (得点) or 'opp' (失点)
    open(side) {
        this.targetSide = side;
        const modal = document.getElementById('reason-modal');
        const container = document.getElementById('reason-buttons-container');
        const title = document.getElementById('reason-modal-title');
        container.innerHTML = ''; // クリア
        if (side === 'our') {
            title.textContent = "自チーム得点：理由を選択";
            this.renderGroup(container, "自チームの得点", this.REASONS.GAIN.self, "reason-good");
            this.renderGroup(container, "相手チームのミス", this.REASONS.GAIN.opp, "reason-neutral");
        } else {
            title.textContent = "相手チーム得点：理由を選択";
            this.renderGroup(container, "相手チームの得点", this.REASONS.LOSS.opp, "reason-neutral"); // 相手のナイスプレーはニュートラル色か赤系
            this.renderGroup(container, "自チームのミス", this.REASONS.LOSS.self, "reason-bad");
        }
        modal.style.display = 'flex';
    },
    renderGroup(container, labelText, items, btnClass) {
        const group = document.createElement('div');
        group.className = 'reason-group';
        const label = document.createElement('div');
        label.className = 'reason-group-label';
        label.textContent = labelText;
        group.appendChild(label);
        const row = document.createElement('div');
        row.className = 'reason-btn-row';
        items.forEach(item => {
            const btn = document.createElement('button');
            btn.className = `reason-btn ${btnClass}`;
            btn.textContent = `${item.label} (${item.code})`;
            btn.onclick = () => this.handleSelection(item);
            row.appendChild(btn);
        });
        group.appendChild(row);
        container.appendChild(group);
    },
    close() {
        document.getElementById('reason-modal').style.display = 'none';
    },
    handleSelection(item) {
        if (item.code === 'B' && this.targetSide === 'our') {
            this.showFrontRowSelector(item);
        } else {
            this.saveLog(item, null); // 通常保存
        }
    },
    showFrontRowSelector(item) {
        const container = document.getElementById('reason-buttons-container');
        const title = document.getElementById('reason-modal-title');
        title.textContent = "ブロックした選手を選択";
        container.innerHTML = ''; // クリア
        const frontRowPlayers = [];
        testRoster.forEach(starter => {
            let visualPos = (starter.position - currentRotation + 1);
            if (visualPos <= 0) visualPos += 6;
            if ([4, 3, 2].includes(visualPos)) {
                const displayId = GameManager.liberoMap[starter.playerId] || starter.playerId;
                const player = testPlayerList[displayId];
                if (player) {
                    frontRowPlayers.push({ ...player, visualPos });
                }
            }
        });
        frontRowPlayers.sort((a, b) => b.visualPos - a.visualPos);
        const row = document.createElement('div');
        row.className = 'reason-btn-row';
        row.style.marginTop = '20px';
        frontRowPlayers.forEach(p => {
            const btn = document.createElement('button');
            btn.className = 'reason-btn reason-good';
            btn.style.padding = '20px';
            btn.innerHTML = `<span style="display:block; font-size:1.2em;">${p.jersey}</span>${p.name}`;
            btn.onclick = () => this.saveLog(item, p.id); // 選手ID付きで保存
            row.appendChild(btn);
        });
        const unknownBtn = document.createElement('button');
        unknownBtn.className = 'reason-btn reason-neutral';
        unknownBtn.textContent = '不明 / チーム';
        unknownBtn.onclick = () => this.saveLog(item, null);
        row.appendChild(unknownBtn);
        container.appendChild(row);
    },
    async saveLog(item, playerId) {
        const isOurPoint = (this.targetSide === 'our');
        GameManager.addScore(isOurPoint);
        const logData = {
            match_id: currentMatchId,
            set_number: currentSetNumber,
            rally_id: currentRallyId,
            rotation_number: currentRotation,
            setter_id: null,
            spiker_id: playerId, // ★選択された選手IDが入る
            attack_type: item.action,
            result: isOurPoint ? 'KILL' : 'FAULT',
            reason: item.code,
            pass_position: null,
            toss_area: null
        };
        try {
            await db.rallyLog.add(logData);
            console.log(`理由付き記録: ${item.code}, Player: ${playerId || 'None'}`);
        } catch (e) {
            console.error("ログ保存失敗", e);
        }
        this.close();
        resetCurrentEntry();
    }
};
window.ReasonInputManager = ReasonInputManager;

// DOMが読み込まれたら実行
document.addEventListener('DOMContentLoaded', () => {
    cacheUIElements();
    setupEventListeners();
    updateSpikerUIRotation(currentRotation);
    updateInputDisplay();
    updateScoreboardUI();
});

/**
 * 3. 画面上のUI要素を一度に取得し、変数に保持する
 */
function cacheUIElements() {
    uiElements.homeScreen = document.getElementById('home-screen');
    uiElements.recordScreen = document.getElementById('record-screen');
    uiElements.menuNewMatch = document.getElementById('menu-new-match');
    uiElements.menuAnalysis = document.getElementById('menu-analysis'); // まだ画面なし
    uiElements.logoRs = document.getElementById('logo-rs');
    uiElements.menuPlayers = document.getElementById('menu-players'); // ホーム画面のボタン
    uiElements.playersScreen = document.getElementById('players-screen');
    uiElements.logoAs = document.getElementById('logo-as');
    uiElements.btnCalcStats = document.getElementById('btn-calc-stats');
    uiElements.tabButtons = document.querySelectorAll('.tab-btn');
    uiElements.logoPs = document.getElementById('logo-ps');
    uiElements.btnAddPlayer = document.getElementById('btn-add-player');
    uiElements.playersTableBody = document.getElementById('players-table-body');
    uiElements.playerEditModal = document.getElementById('player-edit-modal');
    uiElements.inputPlayerName = document.getElementById('input-player-name');
    uiElements.inputPlayerJersey = document.getElementById('input-player-jersey');
    uiElements.inputPlayerPosition = document.getElementById('input-player-position');
    uiElements.editPlayerId = document.getElementById('edit-player-id'); // 隠しフィールド
    uiElements.btnPlayerCancel = document.getElementById('btn-player-cancel');
    uiElements.btnPlayerSave = document.getElementById('btn-player-save');
    uiElements.playerModalTitle = document.getElementById('player-modal-title');
    uiElements.menuSettings = document.getElementById('menu-settings');
    uiElements.settingsScreen = document.getElementById('settings-screen');
    uiElements.logoSs = document.getElementById('logo-ss');
    uiElements.btnExportCsv = document.getElementById('btn-export-csv');
    uiElements.btnDeleteAll = document.getElementById('btn-delete-all');
    uiElements.btnImportCsv = document.getElementById('btn-import-csv');
    uiElements.csvFileInput = document.getElementById('csv-file-input');
    uiElements.importStatus = document.getElementById('import-status');

    uiElements.matchSetupModal = document.getElementById('match-setup-modal');
    uiElements.setupCompetition = document.getElementById('setup-competition');
    uiElements.setupOpponent = document.getElementById('setup-opponent');
    uiElements.setupMatchType = document.getElementById('setup-match-type');
    uiElements.setupLibero1 = document.getElementById('setup-libero-1');
    uiElements.setupLibero2 = document.getElementById('setup-libero-2');
    uiElements.btnSetupCancel = document.getElementById('btn-setup-cancel');
    uiElements.btnMatchStart = document.getElementById('btn-match-start');
    uiElements.btnNextSetStart = document.getElementById('btn-next-set-start');
    uiElements.starterButtons = {};
    for (let i = 1; i <= 6; i++) {
        uiElements.starterButtons[i] = document.getElementById(`btn-starter-${i}`);
    }
    uiElements.playerSelectModal = document.getElementById('player-select-modal');
    uiElements.selectStarterPlayer = document.getElementById('select-starter-player');
    uiElements.selectStarterRole = document.getElementById('select-starter-role');
    uiElements.btnPsCancel = document.getElementById('btn-ps-cancel');
    uiElements.btnPsOk = document.getElementById('btn-ps-ok');
    
    uiElements.menuPlayers = document.getElementById('menu-players');
    uiElements.miniCourt = document.getElementById('mini-court');
    uiElements.tossButtons = document.querySelectorAll('.toss-btn');
    uiElements.playerButtons = document.querySelectorAll('.player-button');
    uiElements.courtTossArea = document.getElementById('court-toss-area');
    uiElements.spikerGridPositions = {};
    for (let i = 1; i <= 6; i++) {
        uiElements.spikerGridPositions[i] = document.getElementById(`grid-pos-${i}`);
    }
    uiElements.substituteModal = document.getElementById('substitute-modal');
    uiElements.substituteModalTitle = document.getElementById('substitute-modal-title');
    uiElements.btnSubstitute = document.getElementById('btn-substitute');
    uiElements.btnSubCancel = document.getElementById('btn-sub-cancel');
    uiElements.btnSubExecute = document.getElementById('btn-sub-execute');
    uiElements.selectPlayerOut = document.getElementById('select-player-out');
    uiElements.selectPlayerIn = document.getElementById('select-player-in');
    uiElements.btnLibero = document.getElementById('btn-libero');
    uiElements.liberoModal = document.getElementById('libero-modal');
    uiElements.liberoModalTitle = document.getElementById('libero-modal-title');
    uiElements.liberoModalBody = document.getElementById('libero-modal-body');
    uiElements.btnLiberoCancel = document.getElementById('btn-libero-cancel');
    uiElements.btnLiberoExecute = document.getElementById('btn-libero-execute');
    uiElements.ourServeIcon = document.getElementById('our-serve-icon');
    uiElements.opponentServeIcon = document.getElementById('opponent-serve-icon');
    uiElements.btnDirect = document.getElementById('btn-input-direct');
    uiElements.btnTwoAttack = document.getElementById('btn-input-two');
    uiElements.btnMiss = document.getElementById('btn-input-miss');
    uiElements.tossFar = document.getElementById('btn-toss-far');
    uiElements.tossNear = document.getElementById('btn-toss-near');
    uiElements.tossLong = document.getElementById('btn-toss-long');
    uiElements.tossShort = document.getElementById('btn-toss-short');
    uiElements.tossHigh = document.getElementById('btn-toss-high');
    uiElements.tossLow = document.getElementById('btn-toss-low');
    uiElements.selectSetter = document.getElementById('select-setter');
    uiElements.selectPassPos = document.getElementById('select-pass-pos');
    uiElements.selectTossArea = document.getElementById('select-toss-area');
    uiElements.btnChance = document.getElementById('btn-chance');
    uiElements.selectSpiker = document.getElementById('select-spiker');
    uiElements.selectAttackType = document.getElementById('select-attack-type');
    uiElements.selectResult = document.getElementById('select-result');
    uiElements.btnCancel = document.getElementById('btn-cancel');
    uiElements.btnAdd = document.getElementById('btn-add');

    uiElements.selectPattern = document.getElementById('select-pattern');
    uiElements.btnLoadPattern = document.getElementById('btn-load-pattern');
    uiElements.btnSavePattern = document.getElementById('btn-save-pattern');
    uiElements.btnRotateLeft = document.getElementById('btn-rotate-left');
    uiElements.btnRotateRight = document.getElementById('btn-rotate-right');

    uiElements.oppTeamNameDisplay = document.getElementById('opp-team-name');
    uiElements.ourScoreDisplay = document.getElementById('our-score-display');
    uiElements.oppScoreDisplay = document.getElementById('opp-score-display');
    uiElements.btnSelfPlus = document.getElementById('btn-self-plus');
    uiElements.btnSelfMinus = document.getElementById('btn-self-minus');
    uiElements.btnServerToggle = document.getElementById('btn-server-toggle');
    uiElements.btnOppPlus = document.getElementById('btn-opp-plus');
    uiElements.btnOppMinus = document.getElementById('btn-opp-minus');
    uiElements.ourSetDisplay = document.getElementById('our-set-display');
    uiElements.oppSetDisplay = document.getElementById('opp-set-display');

    uiElements.btnTimeout = document.getElementById('btn-timeout');
    uiElements.btnSetEnd = document.getElementById('btn-set-end'); 
    uiElements.setEndModal = document.getElementById('set-end-modal');
    uiElements.modalSetNum = document.getElementById('modal-set-num');
    uiElements.modalSetScore = document.getElementById('modal-set-score');
    uiElements.btnGotoAnalysis = document.getElementById('btn-goto-analysis');
    uiElements.btnNextSet = document.getElementById('btn-next-set');
    uiElements.midMatchExitModal = document.getElementById('mid-match-exit-modal');
    uiElements.btnExitCancel = document.getElementById('btn-exit-cancel');
    uiElements.btnExitNoSave = document.getElementById('btn-exit-no-save');
    uiElements.btnExitSave = document.getElementById('btn-exit-save');
    uiElements.matchEndModal = document.getElementById('match-end-modal');
    uiElements.btnEndToAnalysis = document.getElementById('btn-end-to-analysis');
    uiElements.btnEndToHome = document.getElementById('btn-end-to-home');
    
    uiElements.shareToggle = document.getElementById('btn-share-report');
}
function resetTossQualityStates() {
    currentRallyEntry.toss_distance = 'good';
    currentRallyEntry.toss_length = 'good';
    currentRallyEntry.toss_height = 'good';
}
function resetAttackTypeStates() {
    uiElements.btnDirect.classList.remove('active');
    uiElements.btnTwoAttack.classList.remove('active');
}

/**
 * 4. イベントリスナー設定（メイン）
 */
let isEventListenersSetup = false;
function setupEventListeners() {
    if (isEventListenersSetup) {
        console.log("Event listeners already setup. Skipping.");
        return;
    }
    setupNavigationEvents();   // 画面遷移・メニュー
    setupMatchSetupEvents();   // 試合開始前の設定
    setupCourtEvents();        // コート上の操作（トス・スワイプ）
    setupInputEvents();        // ラリー情報入力（右ペイン）
    setupScoreboardEvents();   // 得点板操作
    setupSubstitutionEvents(); // 選手交代・リベロ
    setupSetcountEvents();
    if (uiElements.shareToggle) {
        uiElements.shareToggle.addEventListener('click', () => AnalysisManager.toggleSharePopup(true));
    }
    if (uiElements.btnTimeout) {
        uiElements.btnTimeout.addEventListener('click', () => {
            if (typeof TimeoutManager !== 'undefined') {
                TimeoutManager.open(false);
            } else {
                console.error("TimeoutManager is not defined");
            }
        });
    }
    isEventListenersSetup = true;
}
/** A. 画面遷移・メニュー関連 */
function setupNavigationEvents() {
    // 新規試合・ホーム戻る
    uiElements.menuNewMatch.addEventListener('click', () => openMatchSetupModal());
    uiElements.logoRs.addEventListener('click', () => {
        handleMatchExitRequest();
    });
    // 分析画面
    uiElements.menuAnalysis.addEventListener('click', () => {
        switchScreen('analysis');
        AnalysisManager.init();        // 初期化 (試合リスト取得)
        AnalysisManager.loadAndCalculate(); // とりあえず現在のデータを集計
    });
    if(uiElements.logoAs) {
        uiElements.logoAs.addEventListener('click', () => switchScreen('home'));
    }
    if(uiElements.btnCalcStats) {
        uiElements.btnCalcStats.addEventListener('click', () => AnalysisManager.loadAndCalculate());
    }
    if(uiElements.tabButtons) {
        uiElements.tabButtons.forEach(btn => {
            btn.addEventListener('click', () => AnalysisManager.switchTab(btn.dataset.tab));
        });
    }
    // 選手管理画面
    uiElements.menuPlayers.addEventListener('click', () => {
        switchScreen('players');
        loadPlayersList();
    });
    uiElements.logoPs.addEventListener('click', () => switchScreen('home'));
    // 選手登録・編集モーダル
    uiElements.btnAddPlayer.addEventListener('click', () => openPlayerModal());
    uiElements.btnPlayerCancel.addEventListener('click', closePlayerModal);
    uiElements.btnPlayerSave.addEventListener('click', savePlayerToDB);
    // 終了フロー
    if (uiElements.btnExitCancel) {
        uiElements.btnExitCancel.addEventListener('click', () => {
            uiElements.midMatchExitModal.style.display = 'none';
        });
    }
    if (uiElements.btnExitNoSave) {
        uiElements.btnExitNoSave.addEventListener('click', async () => {
            uiElements.midMatchExitModal.style.display = 'none';
            await endMatchWithoutSaving(); // 保存せず終了処理
        });
    }
    if (uiElements.btnExitSave) {
        uiElements.btnExitSave.addEventListener('click', async () => {
            uiElements.midMatchExitModal.style.display = 'none';
            await endMatchWithSaving(); // 保存して終了処理
        });
    }
    if (uiElements.btnEndToAnalysis) {
        uiElements.btnEndToAnalysis.addEventListener('click', () => {
            uiElements.matchEndModal.style.display = 'none';
            switchScreen('analysis');
            AnalysisManager.init();
            AnalysisManager.loadAndCalculate();
        });
    }
    if (uiElements.btnEndToHome) {
        uiElements.btnEndToHome.addEventListener('click', () => {
            uiElements.matchEndModal.style.display = 'none';
            switchScreen('home');
        });
    }
    if (uiElements.matchEndModal) {
        uiElements.matchEndModal.addEventListener('click', (e) => {
            if (e.target === uiElements.matchEndModal) {
                uiElements.matchEndModal.style.display = 'none';
            }
        });
    }
    // 設定画面
    if (uiElements.menuSettings) {
        uiElements.menuSettings.addEventListener('click', () => {
            switchScreen('settings');
        });
    }
    if (uiElements.logoSs) {
        uiElements.logoSs.addEventListener('click', () => {
            switchScreen('home');
        });
    }
    if (uiElements.btnExportCsv) {
        uiElements.btnExportCsv.addEventListener('click', () => DataManager.exportAllData());
    }
    if (uiElements.btnDeleteAll) {
        uiElements.btnDeleteAll.addEventListener('click', () => DataManager.deleteAllData());
    }
    if (uiElements.btnImportCsv) {
        uiElements.btnImportCsv.addEventListener('click', () => {
            uiElements.csvFileInput.click(); // 隠しinputをクリックさせる
        });
    }
    if (uiElements.csvFileInput) {
        uiElements.csvFileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                DataManager.importCsvData(file);
            }
            e.target.value = '';
        });
    }
    if (document.getElementById('btn-refresh-explorer')) {
        document.getElementById('btn-refresh-explorer').addEventListener('click', () => {
            DataManager.renderExplorer();
        });
    }
    if (uiElements.menuSettings) {
        uiElements.menuSettings.addEventListener('click', () => {
            switchScreen('settings');
            DataManager.renderExplorer(); // ★開くたびに更新
        });
    }
    if (document.getElementById('btn-delete-matches-only')) {
        document.getElementById('btn-delete-matches-only').addEventListener('click', () => {
            DataManager.deleteMatchesOnly();
        });
    }
    if (document.getElementById('btn-backup-json')) {
        document.getElementById('btn-backup-json').addEventListener('click', () => {
            DataManager.exportBackupJSON();
        });
    }
    if (document.getElementById('btn-restore-json')) {
        document.getElementById('btn-restore-json').addEventListener('click', () => {
            document.getElementById('json-file-input').click();
        });
    }
    if (document.getElementById('json-file-input')) {
        document.getElementById('json-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                DataManager.importBackupJSON(file);
            }
            e.target.value = ''; // リセット
        });
    }
}
/** B. 試合設定（スタメン・ベンチ）関連 */
function setupMatchSetupEvents() {
    // 試合設定モーダル
    uiElements.btnSetupCancel.addEventListener('click', () => {
        uiElements.matchSetupModal.style.display = 'none';
    });
    uiElements.btnMatchStart.addEventListener('click', startMatch);
    // スタメン選択ボタン
    for (let i = 1; i <= 6; i++) {
        uiElements.starterButtons[i].addEventListener('click', () => {
            openStarterSelectModal(i);
        });
    }
    // 選手選択モーダル（スタメン用）
    uiElements.btnPsCancel.addEventListener('click', () => {
        uiElements.playerSelectModal.style.display = 'none';
    });
    uiElements.btnPsOk.addEventListener('click', confirmStarterSelection);
    // 役割の自動選択
    uiElements.selectStarterPlayer.addEventListener('change', (e) => {
        const pid = e.target.value;
        const player = allPlayersCache.find(p => p.player_id === pid);
        if (player && player.position) {
            uiElements.selectStarterRole.value = player.position;
        }
    });
    // パターン保存・読み込み・ローテーション
    uiElements.btnSavePattern.addEventListener('click', saveCurrentLineupPattern);
    uiElements.btnLoadPattern.addEventListener('click', loadSelectedPattern);
    uiElements.btnRotateRight.addEventListener('click', () => rotateTempStarters(1));
    uiElements.btnRotateLeft.addEventListener('click', () => rotateTempStarters(-1));
}
/** C. コート操作（左ペイン：トス・スワイプ） */
function setupCourtEvents() {
    // トスエリア判定（スライド開始）
    uiElements.courtTossArea.addEventListener('mousedown', handlePassStart, false);
    uiElements.courtTossArea.addEventListener('touchstart', handlePassStart, false);
    // トスボタン（A, B, C...）
    uiElements.tossButtons.forEach(button => {
        button.addEventListener('click', () => {
            const area = button.id.split('-').pop(); 
            currentRallyEntry.toss_area = area;
            updateInputDisplay(); 
        });
    });
    // スパイカー（選手ボタン）のスワイプ操作
    const playerButtons = document.querySelectorAll('.player-button');
    setupSwipeListeners(playerButtons);
    // スライド終了判定（Window全体で監視）
    window.addEventListener('mouseup', handlePassEnd, false);
    window.addEventListener('touchend', handlePassEnd, false);
}
/** D. ラリー入力操作（右ペイン：プルダウン・ボタン） */
function setupInputEvents() {
    // Undoボタン
    const btnUndo = document.getElementById('btn-undo');
    if (btnUndo) {
        btnUndo.addEventListener('click', async () => {
            if (confirm('直前の記録を削除して、点数を戻しますか？')) {
                await executeUndo();
            }
        });
    }
    const btnOpenLog = document.getElementById('btn-open-log');
    if (btnOpenLog) {
        btnOpenLog.addEventListener('click', () => {
            EditManager.openLogModal();
        });
    }
    const btnLogClose = document.getElementById('btn-log-close');
    if (btnLogClose) {
        btnLogClose.addEventListener('click', () => {
            EditManager.closeLogModal();
        });
    }
    // トス品質ボタン
    setupTossQualityListeners();
    // 特殊攻撃・ミスボタン
    uiElements.btnDirect.addEventListener('click', () => {
        resetTossQualityStates();
        if (currentRallyEntry.attack_type === 'DIRECT') {
            currentRallyEntry.attack_type = null;
            currentRallyEntry.setter_id = currentSetterId;
        } else {
            currentRallyEntry.attack_type = 'DIRECT';
            currentRallyEntry.setter_id = null; // ★NULLにする
        }
        updateInputDisplay();
    });
    uiElements.btnTwoAttack.addEventListener('click', () => {
        resetTossQualityStates();
        if (currentRallyEntry.attack_type === 'TWO_ATTACK') {
            currentRallyEntry.attack_type = null;
            currentRallyEntry.setter_id = currentSetterId;
        } else {
            currentRallyEntry.attack_type = 'TWO_ATTACK';
            currentRallyEntry.setter_id = null; // ★NULLにする
        }
        updateInputDisplay();
    });
    // プルダウン変更
    uiElements.selectSetter.addEventListener('change', (e) => {
        currentRallyEntry.setter_id = e.target.value;
        autoDeterminePassPosition();
    });
    uiElements.selectPassPos.addEventListener('change', (e) => currentRallyEntry.pass_position = e.target.value);
    uiElements.selectTossArea.addEventListener('change', (e) => currentRallyEntry.toss_area = e.target.value);
    uiElements.selectSpiker.addEventListener('change', (e) => {
        currentRallyEntry.spiker_id = e.target.value;
        updateInputDisplay();
    });
    uiElements.selectAttackType.addEventListener('change', (e) => {
        currentRallyEntry.attack_type = e.target.value;
        handleAttackTypeChange(); // 結果の自動補完など
    })
    uiElements.selectResult.addEventListener('change', (e) => currentRallyEntry.result = e.target.value);
    // 登録・キャンセル
    uiElements.btnCancel.addEventListener('click', resetCurrentEntry);
    uiElements.btnAdd.addEventListener('click', addRallyEntryToDB);
}
/** E. スコアボード操作 */
function setupScoreboardEvents() {
    // 自チーム + 
    uiElements.btnSelfPlus.addEventListener('click', () => {
        ReasonInputManager.open('our');
    });
    // 自チーム - (訂正用)
    uiElements.btnSelfMinus.addEventListener('click', () => {
        GameManager.updateScoreManual(true, -1);
    });
    // 相手チーム +
    uiElements.btnOppPlus.addEventListener('click', () => {
        ReasonInputManager.open('opp');
    });
    // 相手チーム - (訂正用)
    uiElements.btnOppMinus.addEventListener('click', () => {
        GameManager.updateScoreManual(false, -1);
    });
    // サーブ権強制切替
    uiElements.btnServerToggle.addEventListener('click', toggleServerManually);
}
/** F. 選手交代・リベロ */
function setupSubstitutionEvents() {
    // 通常交代
    if (uiElements.btnSubstitute) {
        uiElements.btnSubstitute.addEventListener('click', openSubstituteModal);
    }
    if (uiElements.btnSubCancel) {
        uiElements.btnSubCancel.addEventListener('click', closeSubstituteModal);
    }
    if (uiElements.btnSubExecute) {
        uiElements.btnSubExecute.addEventListener('click', executeSubstitution);
    }
    // リベロ交代
    setupLiberoButtonEvents(uiElements.btnLibero);
    uiElements.btnLiberoCancel.addEventListener('click', closeLiberoModal);
    uiElements.btnLiberoExecute.addEventListener('click', executeLiberoSubstitution);
}
function setupSetcountEvents() {
    if (uiElements.btnSetEnd) {
        uiElements.btnSetEnd.addEventListener('click', async () => {
            if (!GameManager.checkSetEndCondition()) return;
            try {
                const result = await GameManager.finishSet();
                if (result) {
                    uiElements.modalSetNum.textContent = result.setNum;
                    uiElements.modalSetScore.textContent = `${result.ourScore} - ${result.oppScore}`;
                    uiElements.setEndModal.style.display = 'flex';
                }
            } catch (err) {
                UIManager.showFeedback("エラーが発生しました。");
            }
        });
    }
    if (uiElements.btnGotoAnalysis) {
        uiElements.btnGotoAnalysis.addEventListener('click', () => {
            uiElements.setEndModal.style.display = 'none';
            TimeoutManager.open(true); 
        });
    }
    if (uiElements.btnNextSet) {
        uiElements.btnNextSet.addEventListener('click', async () => {
            uiElements.setEndModal.style.display = 'none';
            openMatchSetupModalForNextSet();
            try {
                await GameManager.proceedToNextSet();
                resetCurrentEntry();
                UIManager.showFeedback(`第${currentSetNumber}セットを開始します。`);
            } catch (err) {
                console.error("次セット移行エラー:", err);
            }
        });
    }
    if (uiElements.btnNextSetStart) {
        uiElements.btnNextSetStart.addEventListener('click', startNextSet);
    }
}
async function executeUndo() {
    if (GameManager.history.length === 0) {
        return;
    }
    try {
        const lastRecord = await db.rallyLog.orderBy('play_id').last();
        if (lastRecord) {
            await db.rallyLog.delete(lastRecord.play_id);
        }
        if (GameManager.undoState()) {
            updateSpikerUIRotation(currentRotation);
            updateScoreboardDisplay();
            updateScoreboardUI();
            resetCurrentEntry();
            console.log("Undo完了");
        }
    } catch (err) {
        UIManager.showFeedback("Undoに失敗しました。");
    }
}
async function executeCorrection() {
     if (GameManager.history.length === 0) {
        UIManager.showFeedback("修正するデータがありません。");
        return;
    }
    try {
        const lastRecord = await db.rallyLog.orderBy('play_id').last();
        if (!lastRecord) return;
        await executeUndo();
        currentRallyEntry = {
            ...defaultRallyEntry, // デフォルト値をベースに
            ...lastRecord,        // DBの値を上書き
            play_id: null,        // IDはクリア（新規登録にするため）
            rally_id: currentRallyId // Undoされた正しいrally_idを使用
        };
        UIManager.updateInputForm();
        UIManager.showFeedback("直前のデータを呼び出しました。\n修正して「登録」を押してください。");
    } catch (err) {
        console.error("修正モードエラー:", err);
    }
}

/**
 * 5. 現在のステート（currentRallyEntry）を右画面のUI（プルダウン）に反映させる
 */
function handlePassStart(e) {
    // デフォルト動作（スクロール等）を防ぐ
    if (e.cancelable) e.preventDefault(); 
    isSlidingFromCourt = true; 
    const targetElement = e.target;
    let finalPassQuality = 'S2'; // デフォルト値
    if (targetElement.id === 'btn-chance') {
        finalPassQuality = 'CHANCE';
        console.log('Start Slide from: CHANCE');
    } 
    else if (targetElement.id === 'mini-court' || targetElement.closest('#mini-court')) {
        const courtRect = uiElements.miniCourt.getBoundingClientRect();
        const touchEvent = e.touches ? e.touches[0] : e;
        const touchX = touchEvent.clientX; 
        const touchY = touchEvent.clientY;
        const relativeX = (touchX - courtRect.left) / courtRect.width * 100;
        const relativeY = (touchY - courtRect.top) / courtRect.height * 100;
        const A_CENTER_X = 55;   // 右奥
        const A_CENTER_Y = 0;    // ネット際
        const A_RADIUS = 20;     // 半径
        const distSq = Math.pow(relativeX - A_CENTER_X, 2) + Math.pow(relativeY - A_CENTER_Y, 2);
        if (Math.sqrt(distSq) <= A_RADIUS) {
            finalPassQuality = 'A'; 
        } else if (relativeX >= 30 && relativeY <= 33) {
            finalPassQuality = 'B'; 
        } else {
            finalPassQuality = 'S2'; 
        }
    } 
    else {
        finalPassQuality = 'S2'; 
    }
    const selectedTosserId = uiElements.selectSetter.value || currentSetterId;
    if (selectedTosserId) {
        const tosserInfo = testPlayerList[selectedTosserId];    
        if (tosserInfo) {
            if (finalPassQuality !== 'CHANCE') {
                if (tosserInfo.active_position === 'LB') { // active_positionを使う形に修正済み
                    finalPassQuality = 'L2';
                } else if (tosserInfo.active_position !== 'S') {
                    finalPassQuality = 'O';
                }
            }
        }
    }
    currentRallyEntry.pass_position = finalPassQuality;
    updateInputDisplay();
}
function handlePassEnd(e) {
    if (!isSlidingFromCourt) {
        return;
    }
    isSlidingFromCourt = false;
    let endX, endY;
    if (e.type === 'touchend' && e.changedTouches) {
        endX = e.changedTouches[0].clientX;
        endY = e.changedTouches[0].clientY;
    } else {
        endX = e.clientX;
        endY = e.clientY;
    }
    const elementUnderFinger = document.elementFromPoint(endX, endY);
    if (elementUnderFinger) {
        if (elementUnderFinger.classList.contains('toss-btn')) {
            const tossBtn = elementUnderFinger.closest('.toss-btn');
            if (tossBtn) {
                const area = tossBtn.id.split('-').pop(); // IDからエリアを取得
                currentRallyEntry.toss_area = area;
                
                console.log(`1スライド検知: Pass -> ${currentRallyEntry.pass_position}, Toss -> ${area}`);
                updateInputDisplay();
            }
        }
    }
}
function setupTossQualityListeners() {
    uiElements.btnMiss.addEventListener('click', () => {
        resetAttackTypeStates();
        if (currentRallyEntry.toss_distance === 'miss') {
            resetTossQualityStates(); // goodに戻る
        } else {
            currentRallyEntry.toss_distance = 'miss';
            currentRallyEntry.toss_length = 'miss';
            currentRallyEntry.toss_height = 'miss';
            currentRallyEntry.attack_type = 'FOUL';
            currentRallyEntry.result = 'FAULT';
            currentRallyEntry.spiker_id = 'NONE';
        }
        updateInputDisplay();
    });
    uiElements.tossFar.addEventListener('click', () => {
        toggleTossQuality('toss_distance', 'far');
    });
    uiElements.tossNear.addEventListener('click', () => {
        toggleTossQuality('toss_distance', 'near');
    });
    uiElements.tossLong.addEventListener('click', () => {
        toggleTossQuality('toss_length', 'long');
    });
    uiElements.tossShort.addEventListener('click', () => {
        toggleTossQuality('toss_length', 'short');
    });
    uiElements.tossHigh.addEventListener('click', () => {
        toggleTossQuality('toss_height', 'high');
    });
    uiElements.tossLow.addEventListener('click', () => {
        toggleTossQuality('toss_height', 'low');
    });
}
function toggleTossQuality(property, value) {
    resetAttackTypeStates();
    const currentValue = currentRallyEntry[property];
    if (currentValue === value) {
        currentRallyEntry[property] = 'good';
    } else {
        currentRallyEntry[property] = value;
    }
    if (property === 'toss_distance' && currentRallyEntry.toss_distance === 'miss') {
        currentRallyEntry.toss_distance = 'good';
    }
    if (property === 'toss_length' && currentRallyEntry.toss_length === 'miss') {
        currentRallyEntry.toss_length = 'good';
    }
    if (property === 'toss_height' && currentRallyEntry.toss_height === 'miss') {
        currentRallyEntry.toss_height = 'good';
    }
    if (currentRallyEntry.toss_distance === 'miss' && currentValue !== 'good') {
        currentRallyEntry.toss_distance = 'good';
    }
    if (currentRallyEntry.toss_length === 'miss' && currentValue !== 'good') {
        currentRallyEntry.toss_length = 'good';
    }
    if (currentRallyEntry.toss_height === 'miss' && currentValue !== 'good') {
        currentRallyEntry.toss_height = 'good';
    }
    updateInputDisplay();
}
function updateInputDisplay() {
    UIManager.updateInputForm();
    UIManager.updateCourtRotation(currentRotation);
}
function updateScoreboardUI() {
    UIManager.updateScoreboard();
}
function updateScoreboardDisplay() {
    UIManager.updateScoreboard();
}
function updateSpikerUIRotation(rotation) {
    UIManager.updateCourtRotation(rotation);
}
function handleAttackTypeChange() {
    const attackType = uiElements.selectAttackType.value;
    const resultSelect = uiElements.selectResult; // 結果のプルダウン要素
    if (attackType === 'FOUL' || attackType === 'SERVE_MISS') {
        resultSelect.value = 'FAULT';
    } 
    else if (attackType === 'SERVE_ACE' || attackType === 'OPPONENT_MISS') {
        resultSelect.value = 'KILL';
    } 
    else {
    }
    updateInputDisplay();
}

/**
 * 6. DBに「追加」する処理 (「追加」ボタンで呼び出し)
 */
async function addRallyEntryToDB() {
    currentRallyEntry.match_id = currentMatchId;
    currentRallyEntry.set_number = currentSetNumber;
    currentRallyEntry.rotation_number = currentRotation;

    if (!currentRallyEntry.spiker_id || !currentRallyEntry.result) {
        UIManager.showFeedback('スパイカーと結果は必須です。');
        return;
    }

    // --- 修正モードの場合 ---
    if (currentRallyEntry.play_id) {
        try {
            const oldRecord = await db.rallyLog.get(currentRallyEntry.play_id);
            GameManager.applyScoreCorrection(oldRecord, currentRallyEntry);
            await db.rallyLog.put(currentRallyEntry);
            console.log(`【DB更新成功】Play ID: ${currentRallyEntry.play_id}`);
            UIManager.showFeedback('修正を保存しました。');
            
            // ★重要: 修正完了後は必ずIDを消してリセット
            delete currentRallyEntry.play_id;
            resetCurrentEntry();
        } catch (err) {
            console.error('【修正保存失敗】', err);
        }
        return;
    }

    // --- 新規追加モード ---
    const pointDelta = GameManager.calcPointDelta(currentRallyEntry);
    
    // 理由コード自動判定
    let reasonCode = '';
    const type = currentRallyEntry.attack_type;
    const res = currentRallyEntry.result;
    if (res === 'KILL') {
        if (type === 'SERVE_ACE') reasonCode = 'SA';
        else if (type === 'BLOCK') reasonCode = 'B';
        else if (['SPIKE', 'LEFT', 'RIGHT', 'BACK_ATTACK', 'A_QUICK', 'B_QUICK', 'C_QUICK', 'A_SEMI', 'B_SEMI', 'C_SEMI'].includes(type)) reasonCode = 'S';
        else if (type === 'OPPONENT_MISS') reasonCode = 'OP';
        else if (type === 'DIRECT' || type === 'TWO_ATTACK') reasonCode = 'S';
    } else if (res === 'FAULT' || res === 'BLOCKED' || type === 'SERVE_MISS') {
        if (type === 'SERVE_MISS') reasonCode = 'SV';
        else if (res === 'BLOCKED') reasonCode = 'BS';
        else if (['SPIKE', 'LEFT', 'RIGHT', 'BACK_ATTACK', 'A_QUICK', 'B_QUICK'].includes(type)) reasonCode = 'MS';
        else if (type === 'FOUL' || currentRallyEntry.toss_distance === 'miss') reasonCode = 'F';
    }
    currentRallyEntry.reason = reasonCode;

    if (uiElements.btnAdd) uiElements.btnAdd.disabled = true;
    
    try {
        // ★DBに追加（ここで currentRallyEntry に play_id が付与される）
        const id = await db.rallyLog.add(currentRallyEntry);
        console.log(`【DB保存成功】Play ID: ${id}`);

        // ★★★ 修正ポイント: 追加されたIDを即座に削除して、オブジェクトを「新規」状態に戻す ★★★
        delete currentRallyEntry.play_id; 

        // 得点変動の有無で分岐
        if (pointDelta !== 0) {
            const isOurPoint = (pointDelta === 1);
            processPointEnd(isOurPoint); // ここでリセットと画面更新が行われる
        } else {
            // 有効スパイクなら次はチャンス
            const spikeTypes = ['SPIKE', 'LEFT', 'RIGHT', 'BACK_ATTACK', 'A_QUICK', 'B_QUICK', 'C_QUICK', 'A_SEMI', 'B_SEMI', 'C_SEMI'];
            const isEffectiveSpike = spikeTypes.includes(type) && res === 'EFFECTIVE';
            resetCurrentEntry(isEffectiveSpike);
        }

    } catch (err) {
        console.error('【DB保存失敗】', err, currentRallyEntry);
        UIManager.showFeedback("保存エラーが発生しました");
        // エラー時もIDが残らないように消しておく
        delete currentRallyEntry.play_id;
    } finally {
        if (uiElements.btnAdd) uiElements.btnAdd.disabled = false;
    }
}


/**
 * 7. 「取消」または「追加」成功時に、入力ステートをリセットする
 */
function resetCurrentEntry(nextIsChance = false) {
    currentRallyEntry = { ...defaultRallyEntry };
    currentRallyEntry.rally_id = currentRallyId;
    currentRallyEntry.match_id = currentMatchId;
    currentRallyEntry.set_number = currentSetNumber;
    currentRallyEntry.rotation_number = currentRotation;
    const activeSetter = GameManager.getCurrentSetter();
    if (activeSetter) {
        currentRallyEntry.setter_id = activeSetter.id;
        GameManager.state.setterId = activeSetter.id;
        currentSetterId = activeSetter.id;
    } else {
        currentRallyEntry.setter_id = currentSetterId;
    }
    if (nextIsChance) {
        currentRallyEntry.pass_position = 'CHANCE';
    }
    if (typeof resetAttackTypeStates === 'function') resetAttackTypeStates();
    if (uiElements.btnAdd) {
        uiElements.btnAdd.innerHTML = '追&nbsp;加';
        uiElements.btnAdd.style.backgroundColor = '';
    }
    updateInputDisplay();
}


// --- スワイプロジック (DB保存部分を削除し、ステート更新のみに変更) ---
function setupSwipeListeners(buttons) {
    let timer = null;
    let isLongPress = false;
    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipedPlayerId = null;
    const swipeThreshold = 50;
    buttons.forEach(button => {
        // --- タッチデバイス用 ---
        button.addEventListener('touchstart', (e) => {
            swipedPlayerId = button.dataset.playerId;
            swipeStartX = e.touches[0].clientX;
            swipeStartY = e.touches[0].clientY;
            isLongPress = false;
            timer = setTimeout(() => {
                isLongPress = true; 
            }, 600);
        }, { passive: true });
        button.addEventListener('touchend', (e) => {
            if (timer) clearTimeout(timer);
            let swipeEndX = e.changedTouches[0].clientX;
            let swipeEndY = e.changedTouches[0].clientY;
            let deltaX = swipeEndX - swipeStartX;
            let deltaY = swipeEndY - swipeStartY;
            if (Math.abs(deltaX) > swipeThreshold || Math.abs(deltaY) > swipeThreshold) {
                handleSwipeAction(swipedPlayerId, deltaX, deltaY);
            } 
            else {
                if (isLongPress) {
                    const playerId = button.dataset.playerId;
                    openSubstituteModal(playerId, false); 
                } else {
                }
            }
            isLongPress = false;
            swipeStartX = 0;
            swipeStartY = 0;
        });
        // --- マウス操作用 (PCデバッグ用) ---
        button.addEventListener('mousedown', (e) => {
            swipedPlayerId = button.dataset.playerId;
            swipeStartX = e.clientX;
            swipeStartY = e.clientY;
            isLongPress = false;
            timer = setTimeout(() => { isLongPress = true; }, 600);
        });
        button.addEventListener('mouseup', (e) => {
            if (timer) clearTimeout(timer);
            let deltaX = e.clientX - swipeStartX;
            let deltaY = e.clientY - swipeStartY;
            if (Math.abs(deltaX) > swipeThreshold || Math.abs(deltaY) > swipeThreshold) {
                handleSwipeAction(swipedPlayerId, deltaX, deltaY);
            } else {
                if (isLongPress) {
                    const playerId = button.dataset.playerId;
                    openSubstituteModal(playerId, false);
                }
            }
            isLongPress = false;
        });
    });
    function handleSwipeAction(playerId, deltaX, deltaY) {
        let direction = null;
        if (Math.abs(deltaX) > Math.abs(deltaY)) {
            direction = (deltaX > 0) ? 'right' : 'left';
        } else {
            direction = (deltaY > 0) ? 'down' : 'up';
        }
        if (direction) {
            updateRallyOnSwipe(playerId, direction);
        }
    }
}
function autoDeterminePassPosition() {
    const selectedTosserId = uiElements.selectSetter.value;
    let finalPassQuality = currentRallyEntry.pass_position || 'S2'; 
    if (selectedTosserId) {
        const tosserInfo = testPlayerList[selectedTosserId];
        if (tosserInfo) {
            if (tosserInfo.position === 'LB') {
                finalPassQuality = 'L2'; // Liberoがトス主: L2 に上書き
            } else if (tosserInfo.position !== 'S') {
                finalPassQuality = 'O'; // セッターでもリベロでもない: O に上書き
            }
        }
    }
    currentRallyEntry.pass_position = finalPassQuality;
    updateInputDisplay();
}

/**
 * 8. スワイプ時に呼び出され、DB保存の代わりにステートを更新する
 */
function updateRallyOnSwipe(playerId, direction) {
    let result = '';
    switch (direction) {
        case 'up': result = 'KILL'; break;
        case 'down': result = 'FAULT'; break;
        case 'left': result = 'CONTINUE'; break;
        case 'right': result = 'EFFECTIVE'; break;
    }
    currentRallyEntry.spiker_id = playerId;
    currentRallyEntry.result = result;
    if (currentRallyEntry.attack_type === 'TWO_ATTACK' || currentRallyEntry.attack_type === 'DIRECT') {
        currentRallyEntry.setter_id = null;
    }
    const tossArea = currentRallyEntry.toss_area || 'UNKNOWN';
    const determinedAttackType = determineAttackType(playerId, tossArea);
    if (currentRallyEntry.attack_type === null || currentRallyEntry.attack_type === "") {
        currentRallyEntry.attack_type = determinedAttackType;
    }
    updateInputDisplay();
}
window.openSubstituteModal = async function(currentPosId = null, isSetterChange = false) {
    if (typeof currentPosId === 'object' && currentPosId !== null) {
        currentPosId = null; // これで、次のロジックが Generic Mode で実行される
    }
    uiElements.substituteModal.style.display = 'flex';
    uiElements.substituteModalTitle.textContent = isSetterChange ? 'セッター交代' : '選手交代';
    let playersInCourt = []; // コートにいる選手
    let playersOnBench = []; // ベンチにいる選手
    const currentCourtPlayerIds = testRoster.map(s => s.playerId); // スタメン+交代済みの選手ID
    liberoPairs.forEach(pair => {
        currentCourtPlayerIds.push(pair.liberoId);
    });
    Object.values(testPlayerList).forEach(player => {
        if (currentCourtPlayerIds.includes(player.id)) {
            playersInCourt.push(player);
        } else {
            playersOnBench.push(player);
        }
    });
    playersInCourt.sort((a, b) => a.jersey - b.jersey);
    playersOnBench.sort((a, b) => a.jersey - b.jersey);
    let selectOutHtml = '';
    if (isSetterChange || !currentPosId) { 
        selectOutHtml = playersInCourt.map(p => `
            <option value="${p.id}" ${p.id === currentSetterId ? 'selected' : ''}>
                [${p.jersey}] ${p.name}
            </option>
        `).join('');
    
    } else {
        const outPlayer = testPlayerList[currentPosId];
        if (!outPlayer) {
            UIManager.showFeedback("エラー: 交代させる選手のデータが見つかりません。");
            return;
        }
        selectOutHtml = `
            <option value="${outPlayer.id}">[${outPlayer.jersey}] ${outPlayer.name}</option>
        `;
    }
    uiElements.selectPlayerOut.innerHTML = selectOutHtml;
    const selectInHtml = playersOnBench.map(p => `
        <option value="${p.id}">[${p.jersey}] ${p.name}</option>
    `).join('');
    uiElements.selectPlayerIn.innerHTML = selectInHtml;
    uiElements.substituteModal.dataset.isSetterChange = isSetterChange;
    uiElements.substituteModal.dataset.tappedPosId = currentPosId; // タップされた元のポジションの選手IDも保存
};
function closeSubstituteModal() {
    uiElements.substituteModal.style.display = 'none';
}
function executeSubstitution() {
    const playerOutId = uiElements.selectPlayerOut.value;
    const playerInId = uiElements.selectPlayerIn.value;
    if (!playerOutId || !playerInId) {
        UIManager.showFeedback('OUTする選手とINする選手を選択してください。');
        return;
    }
    if (playerOutId === playerInId) {
        UIManager.showFeedback('同じ選手をIN/OUTさせることはできません。');
        return;
    }
    const tappedPosId = uiElements.substituteModal.dataset.tappedPosId;
    const wasSetterOut = (playerOutId === currentSetterId);
    const rosterEntryOutIndex = testRoster.findIndex(s => s.playerId === tappedPosId || s.playerId === playerOutId);
    if (rosterEntryOutIndex > -1) {
        testRoster[rosterEntryOutIndex].playerId = playerInId;
    }
    const playerOut = testPlayerList[playerOutId];
    const roleToInherit = playerOut.active_position; 
    GameManager.updatePlayerStatus(playerOutId, null);
    GameManager.updatePlayerStatus(playerInId, roleToInherit);
    updateSpikerUIRotation(currentRotation);
    populateInGameDropdowns();
    if (wasSetterOut) {
        const candidates = GameManager.getPlayersOnCourt();
        openNewSetterSelection(candidates, playerInId);
        return; // 処理中断
    }
    closeSubstituteModal();
    updateInputDisplay();
}
function openNewSetterSelection(candidates, incomingPlayerId) {
    const titleEl = document.getElementById('player-modal-title');
    if (titleEl) titleEl.textContent = '新セッターの選択';
    if (uiElements.btnPsCancel) uiElements.btnPsCancel.style.display = 'none';
    uiElements.btnPsOk.removeEventListener('click', confirmStarterSelection);
    uiElements.btnPsOk.addEventListener('click', confirmNewSetter, { once: true });
    uiElements.selectStarterPlayer.innerHTML = '<option value="">新セッターを選択してください</option>';
    candidates.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        const isNew = (p.id === incomingPlayerId) ? " (新)" : "";
        opt.textContent = `[${p.jersey}] ${p.name}${isNew}`;
        if (p.id === incomingPlayerId) {
             opt.setAttribute('selected', 'selected');
        }
        uiElements.selectStarterPlayer.appendChild(opt);
    });
    uiElements.playerSelectModal.dataset.incomingPlayerId = incomingPlayerId;
    uiElements.selectStarterRole.disabled = true; // 役割は自動決定されるのでロック
    uiElements.playerSelectModal.style.display = 'flex';
}
function confirmNewSetter() {
    const newSetterId = uiElements.selectStarterPlayer.value;
    const incomingPlayerId = uiElements.playerSelectModal.dataset.incomingPlayerId;
    if (!newSetterId) {
        UIManager.showFeedback("セッターを選択してください。");
        uiElements.btnPsOk.addEventListener('click', confirmNewSetter, { once: true });
        return;
    }
    if (newSetterId === incomingPlayerId) {
        currentSetterId = newSetterId;
        GameManager.state.setterId = newSetterId;
    }
    else {
        const existingPlayer = testPlayerList[newSetterId];
        const oldRole = existingPlayer.active_position; // 例: 'OH'
        GameManager.updatePlayerStatus(newSetterId, 'S');
        GameManager.updatePlayerStatus(incomingPlayerId, oldRole);
        const rosterEntry = testRoster.find(r => r.playerId === incomingPlayerId);
        if (rosterEntry) {
            rosterEntry.designated_position = oldRole;
        }
        const rosterEntryExisting = testRoster.find(r => r.playerId === newSetterId);
        if (rosterEntryExisting) {
            rosterEntryExisting.designated_position = 'S';
        }
        currentSetterId = newSetterId;
        GameManager.state.setterId = newSetterId;
        console.log(`既存選手(${existingPlayer.name})がセッターになり、新選手は ${oldRole} になりました`);
    }
    if (uiElements.btnPsCancel) uiElements.btnPsCancel.style.display = ''; // キャンセルボタンを再表示に戻す
    uiElements.selectStarterRole.disabled = false;
    uiElements.playerSelectModal.style.display = 'none';
    // 画面全体の更新
    closeSubstituteModal();
    updateSpikerUIRotation(currentRotation); // コート表示更新
    populateInGameDropdowns(); // プルダウン更新
    updateInputDisplay();
    resetCurrentEntry();
}
// --- リベロ交代関連の関数群 ---
let liberoPressTimer = null; // 長押しタイマー
function setupLiberoButtonEvents(button) {
    let timer = null;
    let isLongPress = false;
    button.addEventListener('touchstart', (e) => {
        e.preventDefault(); // スクロール等のデフォルト動作を防ぐ
        isLongPress = false;
        timer = setTimeout(() => {
            isLongPress = true;
            handleLiberoLongPress(); // 長押し実行
        }, 600); // 0.6秒で長押しと判定
    }, { passive: false });
    button.addEventListener('touchend', (e) => {
        if (timer) clearTimeout(timer); // タイマー解除
        if (!isLongPress) {
            handleLiberoTap(); // 短いタップならタップ処理実行
        }
    });
    button.addEventListener('mousedown', (e) => {
        isLongPress = false;
        timer = setTimeout(() => {
            isLongPress = true;
            handleLiberoLongPress();
        }, 600);
    });
    button.addEventListener('mouseup', (e) => {
        if (timer) clearTimeout(timer);
        if (!isLongPress) {
            handleLiberoTap();
        }
    });
    button.addEventListener('mouseleave', () => { if (timer) clearTimeout(timer); });
    button.addEventListener('touchcancel', () => { if (timer) clearTimeout(timer); });
}
function handleLiberoTap() {
    const activeLiberoOriginalIds = Object.keys(GameManager.liberoMap);
    const isLiberoActive = activeLiberoOriginalIds.length > 0;
    if (isLiberoActive) {
        // --- リベロ OUT モード ---
        uiElements.liberoModalTitle.textContent = 'リベロ交代 (OUT)';
        const originalId = activeLiberoOriginalIds[0]; 
        const liberoId = GameManager.liberoMap[originalId];
        const liberoObj = testPlayerList[liberoId];
        const originalPlayer = testPlayerList[originalId];
        if (!liberoObj || !originalPlayer) {
            UIManager.showFeedback("選手データが見つかりません。");
            return;
        }
        let html = `
            <div class="select-group">
                <label>OUTする選手</label>
                <p style="font-size: 1.2em; font-weight: bold; color: var(--accent-color, #f1c40f);">
                    [${liberoObj.jersey}] ${liberoObj.name}
                </p>
            </div>
            <div class="select-group">
                <label>INする選手</label>
                <p style="font-size: 1.2em; font-weight: bold;">
                    [${originalPlayer.jersey}] ${originalPlayer.name}
                </p>
            </div>
            <p style="margin-top:10px; color:#666; font-size:0.9em;">リベロをベンチに戻し、元の選手をコートに戻します。</p>
            <input type="hidden" id="libero-action-type" value="OUT">
            <input type="hidden" id="libero-out-target-id" value="${originalId}">
        `;
        uiElements.liberoModalBody.innerHTML = html;
    } else {
        // --- リベロ IN モード (ここは変更なしですが念のため記載) ---
        uiElements.liberoModalTitle.textContent = 'リベロ交代 (IN)';
        let mainLibero = testLiberos['L1'] || testLiberos['L2'] || Object.values(testLiberos)[0];
        
        if (!mainLibero) {
            UIManager.showFeedback("リベロが登録されていません。\n試合設定を確認してください。");
            return;
        }
        const backRowPlayers = getBackRowPlayers(); // 後衛選手リスト取得
        let html = `
            <div class="select-group">
                <label>INする選手</label>
                <p style="font-size: 1.2em; font-weight: bold;">
                    [${mainLibero.jersey}] ${mainLibero.name}
                </p>
            </div>
            <div class="select-group">
                <label for="select-libero-out">OUTする選手(後衛)</label>
                <select id="select-libero-out">
                    ${backRowPlayers.map(p => `<option value="${p.id}">[${p.jersey}] ${p.name}</option>`).join('')}
                </select>
            </div>
            <input type="hidden" id="libero-action-type" value="IN">
            <input type="hidden" id="libero-in-id" value="${mainLibero.id}">
        `;
        uiElements.liberoModalBody.innerHTML = html;
    }
    uiElements.liberoModal.style.display = 'flex';
}
function handleLiberoLongPress() {
    console.log("リベロボタン: 長押し");
    const liberosOnCourt = liberoPairs.map(p => p.liberoId);
    let html = '';
    if (liberosOnCourt.length === 0) {
        uiElements.liberoModalTitle.textContent = 'リベロ交代 (IN)';
        const backRowPlayers = getBackRowPlayers();
        html = `
            <div class="select-group">
                <label for="select-libero-in">INする選手 (リベロ)</label>
                <select id="select-libero-in">
                    ${Object.values(testLiberos).map(l => `<option value="${l.id}">[${l.jersey}] ${l.name}</option>`).join('')}
                </select>
            </div>
            <div class="select-group">
                <label for="select-libero-out">OUTする選手 (後衛)</label>
                <select id="select-libero-out">
                    ${backRowPlayers.map(p => `<option value="${p.id}">[${p.jersey}] ${p.name}</option>`).join('')}
                </select>
            </div>
        `;
    } else {
        uiElements.liberoModalTitle.textContent = 'リベロ同士の交代';
        const otherLibero = Object.values(testLiberos).find(l => !liberosOnCourt.includes(l.id));
        
        if (otherLibero) {
            html = `<p>現在コートにいるリベロと、<b>[${otherLibero.jersey}] ${otherLibero.name}</b> を交代しますか？</p>
                    <input type="hidden" id="libero-swap-in-id" value="${otherLibero.id}">
                   `;
        } else {
            html = `<p>交代できるリベロが登録されていません。</p>`;
        }
    }
    uiElements.liberoModalBody.innerHTML = html;
    uiElements.liberoModal.style.display = 'flex';
}
function closeLiberoModal() {
    uiElements.liberoModal.style.display = 'none';
}
function executeLiberoSubstitution() {
    const actionType = document.getElementById('libero-action-type').value;
    // ケース1: 長押しによるリベロ同士の交代
    const swapInId = document.getElementById('libero-swap-in-id')?.value;
    if (swapInId) {
        const originalIds = Object.keys(GameManager.liberoMap);
        if (originalIds.length > 0) {
            const originalId = originalIds[0];
            const oldLiberoId = GameManager.liberoMap[originalId];
            GameManager.updatePlayerStatus(oldLiberoId, null);
            GameManager.liberoMap[originalId] = swapInId;
            GameManager.updatePlayerStatus(swapInId, 'LB');
        }
    }
    // ケース2: リベロ OUT
    else if (actionType === 'OUT') {
        const originalId = document.getElementById('libero-out-target-id').value;
        const liberoId = GameManager.liberoMap[originalId];
        if (liberoId) {
            GameManager.executeLiberoSwap(liberoId, originalId, false);
        }
    }
    // ケース3: リベロ IN
    else {
        const liberoId = document.getElementById('libero-in-id')?.value 
                      || document.getElementById('select-libero-in')?.value;
        const originalId = document.getElementById('select-libero-out')?.value;
        if (liberoId && originalId) {
            if (GameManager.liberoMap[originalId]) {
                UIManager.showFeedback("その選手は既にリベロと交代しています。");
                return;
            }
            GameManager.executeLiberoSwap(liberoId, originalId, true);
        }
    }
    closeLiberoModal();
    updateInputDisplay();
}
function getBackRowPlayers() {
    const targetOrder = [1, 6, 5]; 
    let players = [];
    targetOrder.forEach(targetPos => {
        const starter = testRoster.find(s => {
            let currentVisualPos = (s.position - currentRotation + 1);
            if (currentVisualPos <= 0) {
                currentVisualPos += 6; 
            }
            return currentVisualPos === targetPos;
        });
        if (starter) {
            players.push(testPlayerList[starter.playerId]);
        }
    });
    return players;
}
function switchScreen(screenName) {
    const screens = [
        'home-screen', 
        'record-screen', 
        'players-screen', 
        'analysis-screen', 
        'settings-screen',
        'timeout-screen'
    ];
    screens.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
    });
    switch (screenName) {
        case 'home':
            uiElements.homeScreen.style.display = 'flex';
            break;
        case 'record':
            uiElements.recordScreen.style.display = 'flex';
            break;
        case 'players':
            uiElements.playersScreen.style.display = 'flex';
            break;
        case 'analysis':
            const analysis = document.getElementById('analysis-screen');
            if (analysis) analysis.style.display = 'flex';
            break;
        case 'settings':
            const settings = document.getElementById('settings-screen');
            if (settings) settings.style.display = 'flex';
            break;
    }
}
async function loadPlayersList() {
    try {
        const players = await db.playerList.toArray();
        players.sort((a, b) => Number(a.current_jersey_number) - Number(b.current_jersey_number));
        uiElements.playersTableBody.innerHTML = '';
        players.forEach(player => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${player.current_jersey_number}</td>
                <td>${player.player_name}</td>
                <td>${translatePosition(player.position)}</td> <td>
                    <button class="action-btn" onclick="openPlayerModal('${player.player_id}')">編集</button>
                    <button class="action-btn" onclick="deletePlayerFromDB('${player.player_id}')">削除</button>
                </td>
            `;
            uiElements.playersTableBody.appendChild(tr);
        });
    } catch (err) {
        console.error('選手リスト読み込み失敗:', err);
    }
}
window.openPlayerModal = async function(id = null) {
    if (id) {
        uiElements.playerModalTitle.textContent = '選手編集';
        uiElements.editPlayerId.value = id;
        const player = await db.playerList.get(id);
        if (player) {
            uiElements.inputPlayerName.value = player.player_name;
            uiElements.inputPlayerJersey.value = player.current_jersey_number;
            uiElements.inputPlayerPosition.value = player.position || 'OH';
        }
    } else {
        uiElements.playerModalTitle.textContent = '選手登録';
        uiElements.editPlayerId.value = ''; // IDなし
        uiElements.inputPlayerName.value = '';
        uiElements.inputPlayerJersey.value = '';
        uiElements.inputPlayerPosition.value = 'OH';
    }
    uiElements.playerEditModal.style.display = 'flex';
};
function closePlayerModal() {
    uiElements.playerEditModal.style.display = 'none';
}
async function savePlayerToDB() {
    const id = uiElements.editPlayerId.value;
    const name = uiElements.inputPlayerName.value;
    const jersey = uiElements.inputPlayerJersey.value;
    const position = uiElements.inputPlayerPosition.value;
    if (!name || !jersey) {
        UIManager.showFeedback('名前と背番号は必須です。');
        return;
    }
    try {
        if (id) {
            await db.playerList.update(id, {
                player_name: name,
                current_jersey_number: Number(jersey),
                position: position
            });
        } else {
            const newId = 'p_' + Date.now(); 
            await db.playerList.add({
                player_id: newId,
                player_name: name,
                current_jersey_number: Number(jersey),
                position: position
            });
        }
        closePlayerModal();
        loadPlayersList();
    } catch (err) {
        console.error('保存失敗:', err);
        UIManager.showFeedback('保存に失敗しました。');
    }
}
window.deletePlayerFromDB = async function(id) {
    if (!confirm('本当に削除しますか？')) return;
    try {
        await db.playerList.delete(id);
        loadPlayersList();
    } catch (err) {
        console.error('削除失敗:', err);
    }
};
function translatePosition(pos) {
    const map = {
        'OH': 'レフト', 'MB': 'センター', 'S': 'セッター', 
        'LB': 'リベロ', 'OP': 'ライト'
    };
    return map[pos] || pos;
}
async function openMatchSetupModal() {
    uiElements.setupCompetition.disabled = false;
    uiElements.setupOpponent.disabled = false;
    uiElements.setupMatchType.disabled = false;
    uiElements.btnMatchStart.style.display = 'inline-block';
    uiElements.btnNextSetStart.style.display = 'none';
    if (uiElements.btnSetupCancel) {
        uiElements.btnSetupCancel.style.display = '';
    }
    try {
        allPlayersCache = await db.playerList.toArray();
        allPlayersCache.sort((a, b) => Number(a.current_jersey_number) - Number(b.current_jersey_number));
    } catch (e) {
        console.error(e);
        UIManager.showFeedback('選手データの読み込みに失敗しました');
        return;
    }
    const updateLiberoSelect = (selectEl) => {
        selectEl.innerHTML = '<option value="">なし</option>';
        allPlayersCache.forEach(p => {
            const opt = document.createElement('option');
            opt.value = p.player_id;
            opt.textContent = `[${p.current_jersey_number}] ${p.player_name}`;
            selectEl.appendChild(opt);
        });
    };
    updateLiberoSelect(uiElements.setupLibero1);
    updateLiberoSelect(uiElements.setupLibero2);
    uiElements.setupCompetition.value = '';
    uiElements.setupOpponent.value = '';
    tempStarters = {};
    for (let i = 1; i <= 6; i++) {
        const btn = uiElements.starterButtons[i];
        btn.classList.remove('set');
        btn.innerHTML = `${i} <br><span style="font-size:10px">(未定)</span>`;
    }
    uiElements.selectPattern.innerHTML = '<option value="">パターンを選択...</option>';
    const patterns = await db.lineupPatterns.toArray();
    patterns.forEach(pat => {
        const opt = document.createElement('option');
        opt.value = pat.id;
        opt.textContent = pat.name;
        uiElements.selectPattern.appendChild(opt);
    });
    uiElements.matchSetupModal.style.display = 'flex';
}
function openMatchSetupModalForNextSet() {
    uiElements.setupCompetition.disabled = true;
    uiElements.setupOpponent.disabled = true;
    uiElements.setupMatchType.disabled = true;
    uiElements.btnMatchStart.style.display = 'none';
    uiElements.btnNextSetStart.style.display = 'inline-block';
    if (uiElements.btnSetupCancel) {
        uiElements.btnSetupCancel.style.display = 'none';
    }
    const toggle = document.getElementById('setup-first-serve');
    if (toggle) {
        if (GameManager.state.firstServerOfCurrentSet === 'our') {
            toggle.checked = false;
        } else {
            toggle.checked = true;
        }
    }
    tempStarters = {};
    testRoster.forEach(entry => {
        const player = testPlayerList[entry.playerId];
        let visualPos = (entry.position - currentRotation + 1);
        if (visualPos <= 0) visualPos += 6;
        tempStarters[visualPos] = {
            playerId: entry.playerId,
            role: player.position || 'OH'
        };
    });
    for (let i = 1; i <= 6; i++) {
        const btn = uiElements.starterButtons[i];
        const starter = tempStarters[i];
        if (starter) {
            const player = allPlayersCache.find(p => p.player_id === starter.playerId);
            if (player) {
                btn.classList.add('set');
                btn.innerHTML = `
                    <span class="jersey">${player.current_jersey_number}</span>
                    <span class="name">${player.player_name}</span>
                `;
            }
        } else {
            btn.classList.remove('set');
            btn.innerHTML = `${i} <br><span style="font-size:10px">(未定)</span>`;
        }
    }
    uiElements.matchSetupModal.style.display = 'flex';
}
function openStarterSelectModal(pos) {
    currentEditingPos = pos;
    uiElements.selectStarterPlayer.innerHTML = '<option value="">選択してください</option>';
    allPlayersCache.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.player_id;
        opt.textContent = `[${p.current_jersey_number}] ${p.player_name}`;
        uiElements.selectStarterPlayer.appendChild(opt);
    });
    if (tempStarters[pos]) {
        uiElements.selectStarterPlayer.value = tempStarters[pos].playerId;
        uiElements.selectStarterRole.value = tempStarters[pos].role;
    }
    uiElements.playerSelectModal.style.display = 'flex';
}
function confirmStarterSelection() {
    const playerId = uiElements.selectStarterPlayer.value;
    const role = uiElements.selectStarterRole.value;
    if (!playerId) {
        delete tempStarters[currentEditingPos];
        const btn = uiElements.starterButtons[currentEditingPos];
        btn.classList.remove('set');
        btn.innerHTML = `${currentEditingPos} <br><span style="font-size:10px">(未定)</span>`;
    } else {
        tempStarters[currentEditingPos] = { playerId, role };
        const player = allPlayersCache.find(p => p.player_id === playerId);
        const btn = uiElements.starterButtons[currentEditingPos];
        btn.classList.add('set');
        btn.innerHTML = `
            <span class="jersey">${player.current_jersey_number}</span>
            <span class="name">${player.player_name}</span>
        `;
    }
    uiElements.playerSelectModal.style.display = 'none';
}
async function startMatch() {
    const competition = uiElements.setupCompetition.value.trim();
    const opponent = uiElements.setupOpponent.value.trim();
    if (!competition || !opponent) {
        UIManager.showFeedback('大会名と対戦相手を入力してください。');
        return;
    }
    if (Object.keys(tempStarters).length < 6) {
        UIManager.showFeedback('スタメンを6人全員設定してください。');
        return;
    }
    const l1Id = uiElements.setupLibero1.value;
    const l2Id = uiElements.setupLibero2.value;
    const isOurServe = document.getElementById('setup-first-serve').checked;
    const today = new Date().toLocaleDateString();
    try {
        // --- A. 既存試合の検索 ---
        const existingMatch = await db.matchInfo
            .filter(m => 
                m.match_date === today && 
                m.competition_name === competition && 
                m.opponent_name === opponent
            )
            .first();
        let matchId;
        let isResume = false;
        if (existingMatch) {
            if (confirm(`同じ条件の試合が見つかりました。\nこの試合の「続き（次のセット）」として開始しますか？\n\nキャンセルを押すと、別試合として新規作成します。`)) {
                matchId = existingMatch.match_id;
                isResume = true;
            }
        }
        // --- B. トランザクション実行 ---
        await db.transaction('rw', db.matchInfo, db.setRoster, db.setSummary, db.rallyLog, async () => {
            if (isResume) {
                await GameManager.restoreMatchState(matchId);
                currentMatchId = GameManager.state.matchId;
                currentSetNumber = GameManager.state.setNumber; // 自動で+1されている
                currentRallyId = GameManager.state.rallyId;               
            } else {
                matchId = await db.matchInfo.add({
                    match_date: today,
                    opponent_name: opponent,
                    competition_name: competition,
                    match_type: uiElements.setupMatchType.value
                });
                GameManager.resetMatch(matchId, 1, null, isOurServe);
                currentMatchId = matchId;
                currentSetNumber = 1;
                currentRallyId = 1;
            }
            // --- C. セット情報の保存 (新規・継続 共通) ---
            // 1. SetRoster (スタメン) 保存
            const rosterEntries = [];
            for (let pos = 1; pos <= 6; pos++) {
                rosterEntries.push({
                    match_id: currentMatchId,
                    set_number: currentSetNumber,
                    player_id: tempStarters[pos].playerId,
                    starting_position: pos,
                    designated_position: tempStarters[pos].role,
                    is_libero: false
                });
            }
            if (l1Id) rosterEntries.push({ match_id: currentMatchId, set_number: currentSetNumber, player_id: l1Id, starting_position: null, designated_position: 'LB', is_libero: true });
            if (l2Id) rosterEntries.push({ match_id: currentMatchId, set_number: currentSetNumber, player_id: l2Id, starting_position: null, designated_position: 'LB', is_libero: true });
            await db.setRoster.bulkPut(rosterEntries); // 上書き許可
            // 2. SetSummary (セット初期化)
            await db.setSummary.put({ // 上書き許可
                match_id: currentMatchId,
                set_number: currentSetNumber,
                our_final_score: 0,
                opponent_final_score: 0,
                set_result: null
            });
            // --- D. アプリ内ステートの更新 ---
            currentRotation = 1; // セット開始時は常に1
            GameManager.state.rotation = 1;
            isOurTeamServing = isOurServe;
            GameManager.state.isOurServing = isOurServe;
            liberoPairs = [];
            // 選手リスト更新
            testPlayerList = {}; 
            allPlayersCache.forEach(p => {
                testPlayerList[p.player_id] = {
                    id: p.player_id,
                    name: p.player_name,
                    jersey: p.current_jersey_number,
                    position: p.position,
                    active_position: null
                };
            });
            // スタメン反映
            for (let pos = 1; pos <= 6; pos++) {
                const starter = tempStarters[pos];
                if (starter) GameManager.updatePlayerStatus(starter.playerId, starter.role);
            }
            testRoster = [];
            for (let pos = 1; pos <= 6; pos++) {
                testRoster.push({ position: pos, playerId: tempStarters[pos].playerId });
            }
            // リベロ更新
            testLiberos = {};
            if (l1Id) testLiberos['L1'] = testPlayerList[l1Id];
            if (l2Id) testLiberos['L2'] = testPlayerList[l2Id];
            // セッター特定
            const setterPos = Object.keys(tempStarters).find(pos => tempStarters[pos].role === 'S');
            if (setterPos) {
                currentSetterId = tempStarters[setterPos].playerId;
            } else {
                currentSetterId = null;
            }
            GameManager.state.setterId = currentSetterId;
            UIManager.updateCompetitionName(competition);
            // --- E. 画面更新 ---
            if (uiElements.oppTeamNameDisplay) {
                uiElements.oppTeamNameDisplay.textContent = opponent;
            }
            console.log(`試合開始: MatchID=${currentMatchId}, Set=${currentSetNumber}`);
            uiElements.matchSetupModal.style.display = 'none'; 
            populateInGameDropdowns();
            updateScoreboardUI();
            UIManager.updateScoreboard(); // セットカウント表示更新のため
            updateSpikerUIRotation(currentRotation);
            resetCurrentEntry();
            switchScreen('record');
            if (isResume) {
                UIManager.showFeedback(`試合データを引き継ぎました。\n第${currentSetNumber}セットを開始します。`);
            } else {
                UIManager.showFeedback("試合を開始します。");
            }
        });
    } catch (err) {
        console.error("試合開始エラー:", err);
        UIManager.showFeedback("試合の作成に失敗しました: " + err);
    }
}
async function startNextSet() {
    if (Object.keys(tempStarters).length < 6) {
        UIManager.showFeedback('スタメンを6人設定してください。');
        return;
    }
    const l1Id = uiElements.setupLibero1.value;
    const l2Id = uiElements.setupLibero2.value;
    const isOurServe = document.getElementById('setup-first-serve').checked;
    try {
        await GameManager.proceedToNextSet(); 
        const newSetNum = GameManager.state.setNumber;
        const rosterEntries = [];
        for (let pos = 1; pos <= 6; pos++) {
            rosterEntries.push({
                match_id: currentMatchId,
                set_number: newSetNum,
                player_id: tempStarters[pos].playerId,
                starting_position: pos,
                designated_position: tempStarters[pos].role,
                is_libero: false
            });
        }
        if (l1Id) {
            rosterEntries.push({
                match_id: currentMatchId, set_number: newSetNum, player_id: l1Id,
                starting_position: null, designated_position: 'LB', is_libero: true
            });
        }
        if (l2Id) {
            rosterEntries.push({
                match_id: currentMatchId, set_number: newSetNum, player_id: l2Id,
                starting_position: null, designated_position: 'LB', is_libero: true
            });
        }
        await db.setRoster.bulkPut(rosterEntries); // bulkPutで上書き保存
        GameManager.state.isOurServing = isOurServe;
        GameManager.state.firstServerOfCurrentSet = isOurServe ? 'our' : 'opp';
        GameManager.syncGlobals();
        liberoPairs = [];
        testRoster = [];
        for (let pos = 1; pos <= 6; pos++) {
            testRoster.push({
                position: pos,
                playerId: tempStarters[pos].playerId
            });
        }
        testLiberos = {};
        if (l1Id) testLiberos['L1'] = testPlayerList[l1Id];
        if (l2Id) testLiberos['L2'] = testPlayerList[l2Id];
        const setterPos = Object.keys(tempStarters).find(pos => tempStarters[pos].role === 'S');
        if (setterPos) {
            currentSetterId = tempStarters[setterPos].playerId;
            GameManager.state.setterId = currentSetterId;
        }
        console.log(`第${newSetNum}セット開始`);
        uiElements.matchSetupModal.style.display = 'none';
        currentRotation = 1; // セット開始時は必ずローテ1
        GameManager.state.rotation = 1;
        updateScoreboardUI();
        updateSpikerUIRotation(currentRotation);
        populateInGameDropdowns();
        resetCurrentEntry();
        UIManager.showFeedback(`第${newSetNum}セットを開始します。`);
    } catch (err) {
        console.error("次セット開始エラー:", err);
        UIManager.showFeedback("エラーが発生しました: " + err);
    }
}
function populateInGameDropdowns() {
    const selects = [uiElements.selectSetter, uiElements.selectSpiker];
    const playersInCourt = GameManager.getPlayersOnCourt();
    playersInCourt.sort((a, b) => Number(a.jersey) - Number(b.jersey));
    selects.forEach(selectEl => {
        const defaultText = (selectEl.id === 'select-setter') ? 'トス主' : 'スパイカー';
        selectEl.innerHTML = `<option value="">${defaultText}</option>`;
        playersInCourt.forEach(p => {
            const option = document.createElement('option');
            option.value = p.id;
            option.textContent = `[${p.jersey}] ${p.name}`;
            selectEl.appendChild(option);
        });
    });
}
async function saveCurrentLineupPattern() {
    if (Object.keys(tempStarters).length < 6) {
        UIManager.showFeedback('保存するには6人のスタメンを設定してください。');
        return;
    }
    const name = prompt('パターンの名前を入力してください (例: Aチーム)');
    if (!name) return;
    try {
        await db.lineupPatterns.add({
            name: name,
            starters: tempStarters, // オブジェクトをそのまま保存
            libero1: uiElements.setupLibero1.value,
            libero2: uiElements.setupLibero2.value
        });
        UIManager.showFeedback(`パターン「${name}」を保存しました。`);
        const patterns = await db.lineupPatterns.toArray();
        uiElements.selectPattern.innerHTML = '<option value="">パターンを選択...</option>';
        patterns.forEach(pat => {
            const opt = document.createElement('option');
            opt.value = pat.id;
            opt.textContent = pat.name;
            uiElements.selectPattern.appendChild(opt);
        });
        uiElements.selectPattern.value = patterns[patterns.length - 1].id;
    } catch (e) {
        console.error(e);
        UIManager.showFeedback('保存に失敗しました');
    }
}
async function loadSelectedPattern() {
    const id = Number(uiElements.selectPattern.value);
    if (!id) return;
    try {
        const pattern = await db.lineupPatterns.get(id);
        if (!pattern) return;
        tempStarters = pattern.starters;
        if (pattern.libero1) uiElements.setupLibero1.value = pattern.libero1;
        if (pattern.libero2) uiElements.setupLibero2.value = pattern.libero2;
        for (let i = 1; i <= 6; i++) {
            const btn = uiElements.starterButtons[i];
            const starter = tempStarters[i];
            if (starter) {
                const player = allPlayersCache.find(p => p.player_id === starter.playerId);
                if (player) {
                    btn.classList.add('set');
                    btn.innerHTML = `
                        <span class="jersey">${player.current_jersey_number}</span>
                        <span class="name">${player.player_name}</span>
                    `;
                }
            } else {
                btn.classList.remove('set');
                btn.innerHTML = `${i} <br><span style="font-size:10px">(未定)</span>`;
            }
        }
    } catch (e) {
        console.error(e);
        UIManager.showFeedback('読み込みに失敗しました');
    }
}
function rotateTempStarters(direction) {
    if (Object.keys(tempStarters).length === 0) return;
    const newStarters = {};
    for (let pos = 1; pos <= 6; pos++) {
        if (tempStarters[pos]) {
            let newPos;
            if (direction === 1) {
                newPos = pos - 1;
                if (newPos < 1) newPos = 6;
            } else { // 戻す（反時計回り移動）
                newPos = pos + 1;
                if (newPos > 6) newPos = 1;
            }
        }
    }
    for (let currentPos = 1; currentPos <= 6; currentPos++) {
        if (!tempStarters[currentPos]) continue;
        let nextPos;
        if (direction === 1) { // ローテ (1->6, 6->5...)
            nextPos = currentPos === 1 ? 6 : currentPos - 1;
        } else { // 逆ローテ (6->1, 5->6...)
            nextPos = currentPos === 6 ? 1 : currentPos + 1;
        }
        newStarters[nextPos] = tempStarters[currentPos];
    }
    tempStarters = newStarters;
    for (let i = 1; i <= 6; i++) {
        const btn = uiElements.starterButtons[i];
        const starter = tempStarters[i];
        
        if (starter) {
            const player = allPlayersCache.find(p => p.player_id === starter.playerId);
            if (player) {
                btn.classList.add('set');
                btn.innerHTML = `
                    <span class="jersey">${player.current_jersey_number}</span>
                    <span class="name">${player.player_name}</span>
                `;
            }
        } else {
            btn.classList.remove('set');
            btn.innerHTML = `${i} <br><span style="font-size:10px">(未定)</span>`;
        }
    }
}
function processPointEnd(didOurTeamWin) {
    GameManager.addScore(didOurTeamWin);
    currentRotation = GameManager.state.rotation;
    ourScore = GameManager.state.ourScore;
    opponentScore = GameManager.state.opponentScore;
    isOurTeamServing = GameManager.state.isOurServing;
    currentRallyId = GameManager.state.rallyId;
    defaultRallyEntry.rotation_number = currentRotation;
    defaultRallyEntry.rally_id = currentRallyId;
    currentRallyEntry.rotation_number = currentRotation;
    if (defaultRallyEntry.play_id) delete defaultRallyEntry.play_id;
    updateSpikerUIRotation(currentRotation);
    updateScoreboardDisplay();
    updateScoreboardUI();
    populateInGameDropdowns();
}
function toggleServerManually() {
    isOurTeamServing = !isOurTeamServing; 
    updateScoreboardUI();
}
function determineAttackType(spikerId, tossArea) {
    if (!spikerId) return 'UNKNOWN';
    const playerInfo = testPlayerList[spikerId];
    if (!playerInfo) return 'UNKNOWN';
    const rosterEntry = testRoster.find(r => r.playerId === spikerId);
    if (!rosterEntry) return 'UNKNOWN';
    const playerRole = rosterEntry.designated_position || playerInfo.position;
    if (playerRole === 'MB') {
        if (tossArea === 'A') return 'A_QUICK';
        if (tossArea === 'B') return 'B_QUICK';
        if (tossArea === 'C') return 'C_QUICK';
    }
    if (playerRole === 'OH' || playerRole === 'OP') {
        if (tossArea === 'A') return 'A_SEMI';
        if (tossArea === 'B') return 'B_SEMI';
        if (tossArea === 'C') return 'C_SEMI';
    }
    if (tossArea === 'BACK') {
        return 'BACK_ATTACK';
    }
    if (tossArea === 'L') {
        return 'LEFT'; // レフトオープン
    }
    if (tossArea === 'R') {
        return 'RIGHT'; // ライトオープン
    }
    return 'SPIKE';
}
async function handleMatchExitRequest() {
    const s1 = GameManager.state.ourScore;
    const s2 = GameManager.state.opponentScore;
    if (s1 === 0 && s2 === 0) {
        const mId = GameManager.state.matchId;
        const sNum = GameManager.state.setNumber;
        try {
            await db.rallyLog.where('match_id').equals(mId)
                .filter(r => r.set_number === sNum).delete();
            await db.setSummary.where('[match_id+set_number]').equals([mId, sNum]).delete();
            await db.setRoster.where('[match_id+set_number]').equals([mId, sNum]).delete();
            if (sNum === 1) {
                await db.matchInfo.delete(mId);
                console.log(`試合(ID:${mId})作成をキャンセルしました。`);
                UIManager.showFeedback("試合作成をキャンセルしてホームに戻りました。");
            } else {
                console.log(`セット${sNum}のデータを破棄しました。`);
                UIManager.showFeedback("記録のないセットを破棄してホームに戻りました。");
            }
            switchScreen('home');
        } catch (err) {
            console.error("自動削除エラー:", err);
            switchScreen('home');
        }
    } else {
        uiElements.midMatchExitModal.style.display = 'flex';
    }
}
function showMatchEndModal() {
    uiElements.matchEndModal.style.display = 'flex';
}
async function endMatchWithoutSaving() {
    const mId = GameManager.state.matchId;
    const sNum = GameManager.state.setNumber;
    try {
        await db.rallyLog
            .where('match_id').equals(mId)
            .filter(r => r.set_number === sNum)
            .delete();
        await db.setSummary
            .where('[match_id+set_number]')
            .equals([mId, sNum])
            .delete();
        console.log(`セット${sNum}のデータを破棄しました。`);
        showMatchEndModal();
    } catch (err) {
        console.error("データ削除エラー:", err);
        UIManager.showFeedback("データの削除に失敗しましたが、ホームへ戻ります。");
        showMatchEndModal();
    }

}


