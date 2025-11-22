// --- データベース定義 (変更なし) ---
const db = new Dexie('VMetricsDB');
db.version(1).stores({
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
        toss_height
    `,
    setSummary: '[match_id+set_number]',
    lineupPatterns: '++id, name'
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
        isSliding: false
    },
    history: [],
    saveSnapshot() {
        const snapshot = JSON.parse(JSON.stringify(this.state));
        this.history.push(snapshot);
        if (this.history.length > 10) this.history.shift();
    },
    undoState() {
        if (this.history.length === 0) {
            UIManager.showFeedback("これ以上戻れません。");
            return false;
        }
        const prevState = this.history.pop();
        this.state = prevState; // 状態を丸ごと書き戻す
        this.syncGlobals();     // グローバル変数にも反映
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
        this.syncGlobals(); // グローバル変数にも反映
    },
    addScore(isOurPoint) {
        this.saveSnapshot();
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
        this.syncGlobals(); // グローバル変数にも反映
    },
    rotate() {
        this.state.rotation = (this.state.rotation % 6) + 1;
        this.validateLiberoPositions();
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
        return Object.values(testPlayerList).filter(p => p.active_position !== null);
    },
    getCurrentSetter() {
        const setter = Object.values(testPlayerList).find(p => p.active_position === 'S');
        return setter || testPlayerList[this.state.setterId];
    },
    getCurrentLiberos() {
        return Object.values(testPlayerList).filter(p => p.active_position === 'LB');
    },
    validateLiberoPositions() {
        const activePairs = [...liberoPairs]; 
        activePairs.forEach(pair => {
            const starter = testRoster.find(s => s.playerId === pair.playerOutId); // 元のスタメン枠
            if (!starter) return;
            let visualPos = (starter.position - this.state.rotation + 1);
            if (visualPos <= 0) visualPos += 6;
            const isFrontRow = (visualPos === 2 || visualPos === 3 || visualPos === 4);
            if (isFrontRow) {
                this.updatePlayerStatus(pair.liberoId, null); // リベロ -> ベンチ(null)
                const originalPlayer = testPlayerList[pair.playerOutId];
                this.updatePlayerStatus(pair.playerOutId, originalPlayer.position); 
                liberoPairs = liberoPairs.filter(p => p.playerOutId !== pair.playerOutId);
            }
        });
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
    // コート上の選手配置（ローテーション）更新
    updateCourtRotation(rotation) {
        const playerOutToLibero = {};
        liberoPairs.forEach(pair => playerOutToLibero[pair.playerOutId] = pair.liberoId);
        // リベロボタンの見た目更新
        if (liberoPairs.length > 0) {
            uiElements.btnLibero.classList.add('libero-in');
            uiElements.btnLibero.textContent = 'リベロ OUT';
        } else {
            uiElements.btnLibero.classList.remove('libero-in');
            uiElements.btnLibero.textContent = 'リベロ IN';
        }
        // グリッド（コート上の6箇所）の描画
        testRoster.forEach(starter => {
            let visualPos = (starter.position - rotation + 1);
            if (visualPos <= 0) visualPos += 6;
            const starterId = starter.playerId;
            let playerInfo = testPlayerList[starterId];
            // リベロ判定ロジック
            const isBackRow = (visualPos === 1 || visualPos === 6 || visualPos === 5);
            const pairedLiberoId = playerOutToLibero[starterId];

            if (pairedLiberoId && isBackRow) {
                playerInfo = testPlayerList[pairedLiberoId]; // リベロと交代中
            } else if (pairedLiberoId && !isBackRow) {
                // 前衛に上がったのでリベロは自動で下がる（データ上の同期は別途必要だが表示は元に戻す）
                playerInfo = testPlayerList[starterId];
            }
            // DOM書き換え
            const gridEl = uiElements.spikerGridPositions[visualPos];
            if (gridEl && playerInfo) {
                gridEl.innerHTML = `
                    <span class="jersey">${playerInfo.jersey}</span>
                    <span class="name">${playerInfo.name}</span>
                `;
                gridEl.dataset.playerId = playerInfo.id;
                // リベロなら色を変えるなどのクラス付与
                if (playerInfo.position === 'LB' || playerInfo.position === 'Libero') {
                    gridEl.classList.add('libero-active');
                } else {
                    gridEl.classList.remove('libero-active');
                }
            }
        });
        // 選手ボタンのスワイプイベントを再設定
        const playerButtons = document.querySelectorAll('.player-button');
        setupSwipeListeners(playerButtons);
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
                            <span style="font-size:0.9em; color:#666;">[${player.jersey}] ${player.name} : ${actionName}</span>
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
        const totalTab = document.querySelector('.sub-tab-btn[data-filter="total"]');
        if(totalTab) totalTab.click();
    },
    // --- 計算ロジック ---
    calculateMetrics(dataset) {
        const TS = dataset.filter(row => row.player !== 'none').length;
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
        metrics.AS = (metrics.TS / denominator);
        metrics.AK = (metrics.TK / denominator);
        metrics.AC = (spikeData.filter(row => row.pass === 'CHANCE').length / denominator);
        metrics.AA = (spikeData.filter(row => row.pass === 'A').length / denominator);
        return metrics;
    },
    calculateSpikerStats(data) {
        const stats = {};
        const allPlayers = new Set(data.filter(row => row.player && row.player !== 'none').map(row => row.player));
        allPlayers.forEach(player => {
            const playerData = data.filter(row => row.player === player);
            stats[player] = this.calculateMetrics(playerData);
        });
        return stats;
    },
    calculateSpikerTossStats(data) {
        const stats = {};
        const allPlayers = new Set(data.filter(row => row.player && row.player !== 'none').map(row => row.player));
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
        const stats = { good: 0, far: 0, near: 0, long: 0, short: 0, high: 0, low: 0, miss: 0, otherTotal: 0, totalTosses: setterData.length, top10Map: new Map() };
        if (stats.totalTosses === 0) { stats.top10 = []; return stats; }
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
            stats.top10Map.set(qualityKey, (stats.top10Map.get(qualityKey) || 0) + 1);
        });
        stats.top10 = Array.from(stats.top10Map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10);
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
        Array.from(allPlayersSet).sort().forEach(player => {
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
        const stats = this.calculateSetterStats(baseData, selectedPlayer, selectedCut);
        this.renderSetterStats(stats);
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
        const sortedPlayers = Object.keys(spikerStats).sort();
        const formatRate = (rate) => isNaN(rate) ? '--.-%' : `${(rate * 100).toFixed(1)}%`;
        sortedPlayers.forEach(player => {
            const stats = spikerStats[player];
            const avgSpikes = (stats.TS / denominator).toFixed(1);
            const classes = {
                PK: this.getStatColorClass('PK', stats.PK),
                PE: this.getStatColorClass('PE', stats.PE),
                PK_Effective: this.getStatColorClass('PK_Effective', stats.PK_Effective),
                PF: this.getStatColorClass('PF', stats.PF),
                PC: this.getStatColorClass('PC', stats.PC),
                PA: this.getStatColorClass('PA', stats.PA),
                PCA: this.getStatColorClass('PCA', stats.PCA),
                PK_HighOpp: this.getStatColorClass('PK_HighOpp', stats.PK_HighOpp),
                PB: this.getStatColorClass('PB', stats.PB),
                P2: this.getStatColorClass('P2', stats.P2),
            };
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${player}</td><td>${avgSpikes}</td>
                <td class="${classes.PK}">${formatRate(stats.PK)}</td>
                <td class="${classes.PE}">${formatRate(stats.PE)}</td>
                <td class="${classes.PK_Effective}">${formatRate(stats.PK_Effective)}</td>
                <td class="${classes.PF}">${formatRate(stats.PF)}</td>
                <td class="${classes.PC}">${formatRate(stats.PC)}</td>
                <td class="${classes.PA}">${formatRate(stats.PA)}</td>
                <td class="${classes.PCA}">${formatRate(stats.PCA)}</td>
                <td class="${classes.PK_HighOpp}">${formatRate(stats.PK_HighOpp)}</td>
                <td class="${classes.PB}">${formatRate(stats.PB)}</td>
                <td class="${classes.P2}">${formatRate(stats.P2)}</td>
            `;
            this.dom.spikerTableBody.appendChild(row);
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
            // --- 2. TOP10リスト描画 ---
            if (list) {
                list.innerHTML = '';
                if(this.dom.setterTop5Header) this.dom.setterTop5Header.textContent = "トスの質 組み合わせ Top 10";
                stats.top10.forEach(([key, count], index) => {
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
    switchTab(tabName) {
        if (tabName === 'spike') {
            document.querySelector('.tab-btn[data-view="spiker"]').click();
        } else if (tabName === 'pass') {
        } else if (tabName === 'toss') {
            document.querySelector('.tab-btn[data-view="setter"]').click();
        }
    }
};
const TimeoutManager = {
    dom: {},
    init() {
        const d = document;
        this.dom = {
            screen: d.getElementById('timeout-screen'),
            btnClose: d.getElementById('btn-to-close'),
            setNum: d.getElementById('to-set-num'),
            ourScore: d.getElementById('to-our-score'),
            oppScore: d.getElementById('to-opp-score'),
            killRate: d.getElementById('to-kill-rate'),
            effRate: d.getElementById('to-eff-rate'),
            barKill: d.getElementById('to-bar-kill'),
            sideoutRate: d.getElementById('to-sideout-rate'),
            sideoutCount: d.getElementById('to-sideout-count'),
            barSideout: d.getElementById('to-bar-sideout'),
            passGood: d.getElementById('to-pass-good'),
            passError: d.getElementById('to-pass-error'),
            barPassA: d.getElementById('to-bar-pass-a'),
            barPassB: d.getElementById('to-bar-pass-b'),
            barPassChance: d.getElementById('to-bar-pass-chance'),
            topScorers: d.getElementById('to-top-scorers'),
            errSpike: d.getElementById('to-err-spike'),
            errServe: d.getElementById('to-err-serve'),
            errRece: d.getElementById('to-err-rece'),
            errOther: d.getElementById('to-err-other'),
        };
        if (this.dom.btnClose) {
            this.dom.btnClose.addEventListener('click', () => {
                this.dom.screen.style.display = 'none';
            });
        }
    },
    async open() {
        if (!this.dom.screen) this.init();
        try {
            const logs = await db.rallyLog
                .where('match_id')
                .equals(currentMatchId)
                .filter(record => record.set_number === currentSetNumber)
                .toArray();
            const stats = this.calculateQuickStats(logs);
            this.render(stats);
            this.dom.screen.style.display = 'flex';
        } catch (err) {
            UIManager.showFeedback("データの読み込みに失敗しました。");
        }
    },
    calculateQuickStats(logs) {
        const s = {
            scoreOur: ourScore,
            scoreOpp: opponentScore,
            setNum: currentSetNumber,
            spikes: 0, kills: 0, errors: 0,
            passTotal: 0, passA: 0, passB: 0, passC: 0, passErr: 0,
            sideoutOpp: 0, sideoutSuccess: 0, // 機会数, 成功数
            errServe: 0, errRece: 0, errSpike: 0, errOther: 0,
            playerScores: {} // { pid: { kills:0, total:0 } }
        };
        logs.forEach(l => {
            if (['SPIKE', 'LEFT', 'RIGHT', 'BACK_ATTACK', 'A_QUICK', 'B_QUICK', 'C_QUICK', 'A_SEMI', 'B_SEMI', 'C_SEMI'].includes(l.attack_type) || (!l.attack_type && l.spiker_id)) {
                if (l.spiker_id) {
                    s.spikes++;
                    if (!s.playerScores[l.spiker_id]) s.playerScores[l.spiker_id] = { kills: 0, total: 0 };
                    s.playerScores[l.spiker_id].total++;

                    if (l.result === 'KILL') {
                        s.kills++;
                        s.playerScores[l.spiker_id].kills++;
                    } else if (l.result === 'FAULT' || l.result === 'BLOCKED') {
                        s.errors++;
                        s.errSpike++;
                    }
                }
            }
            if (['A', 'B', 'CHNACE', 'S2', 'L2', 'O'].includes(l.pass_position)) {
                s.passTotal++;
                if (l.pass_position === 'A') s.passA++;
                else if (l.pass_position === 'B') s.passB++;
                else if (l.pass_position === 'CHANCE') s.passChance++;
                else s.passC++; // その他はC扱い
            }
            if (l.attack_type === 'SERVE_ACE') { // 被エース＝レシーブミス
                s.passTotal++;
                s.passErr++;
                s.errRece++;
            }
            if (l.attack_type === 'SERVE_MISS') s.errServe++;
            if (l.attack_type === 'FOUL' && l.result === 'FAULT') s.errOther++;
        });
        s.sideoutOpp = s.passTotal; // レセプション回数 ≒ サイドアウト機会
        s.sideoutSuccess = s.kills; 

        return s;
    },

    render(s) {
        this.dom.setNum.textContent = s.setNum;
        this.dom.ourScore.textContent = s.scoreOur;
        this.dom.oppScore.textContent = s.scoreOpp;
        const kRate = s.spikes ? (s.kills / s.spikes * 100).toFixed(1) : 0.0;
        const eRate = s.spikes ? ((s.kills - s.errors) / s.spikes * 100).toFixed(1) : 0.0;
        this.dom.killRate.textContent = `${kRate}%`;
        this.dom.effRate.textContent = `${eRate}%`;
        this.dom.barKill.style.width = `${kRate}%`;
        const soRate = s.sideoutOpp ? (s.kills / s.sideoutOpp * 100).toFixed(1) : 0.0; // ※仮ロジック
        this.dom.sideoutRate.textContent = `${soRate}%`;
        this.dom.sideoutCount.textContent = `決定: ${s.kills} / 受数: ${s.sideoutOpp}`;
        this.dom.barSideout.style.width = `${Math.min(soRate, 100)}%`;
        const pA = s.passTotal ? (s.passA / s.passTotal * 100) : 0;
        const pB = s.passTotal ? (s.passB / s.passTotal * 100) : 0;
        const pChance = s.passTotal ? (s.passC / s.passTotal * 100) : 0;
        const goodRate = s.passTotal ? ((s.passA + s.passB) / s.passTotal * 100).toFixed(1) : 0.0;
        this.dom.passGood.textContent = `${goodRate}%`;
        this.dom.passError.textContent = s.passErr;
        this.dom.barPassA.style.width = `${pA}%`;
        this.dom.barPassB.style.width = `${pB}%`;
        this.dom.barPassChance.style.width = `${pChance}%`;
        const sortedPlayers = Object.entries(s.playerScores)
            .sort((a, b) => b[1].kills - a[1].kills)
            .slice(0, 3); // Top 3
        this.dom.topScorers.innerHTML = '';
        sortedPlayers.forEach(([pid, val]) => {
            const p = testPlayerList[pid] || { name: 'Unknown', jersey: '?' };
            const rate = val.total ? (val.kills / val.total * 100).toFixed(0) : 0;
            
            const li = document.createElement('li');
            li.innerHTML = `
                <span>[${p.jersey}] ${p.name}</span>
                <span class="to-val">${val.kills}本 (${rate}%)</span>
            `;
            this.dom.topScorers.appendChild(li);
        });
        this.dom.errSpike.textContent = s.errSpike;
        this.dom.errServe.textContent = s.errServe;
        this.dom.errRece.textContent = s.errRece;
        this.dom.errOther.textContent = s.errOther;
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
            const timestamp = new Date().toISOString().slice(0,10).replace(/-/g,"");
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
    }
};

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
function setupEventListeners() {
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
                TimeoutManager.open();
            } else {
                console.error("TimeoutManager is not defined");
            }
        });
    }
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
    // 設定画面への遷移
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
    // CSVエクスポート & 全削除
    if (uiElements.btnExportCsv) {
        uiElements.btnExportCsv.addEventListener('click', () => DataManager.exportAllData());
    }
    if (uiElements.btnDeleteAll) {
        uiElements.btnDeleteAll.addEventListener('click', () => DataManager.deleteAllData());
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
        currentRallyEntry.attack_type = (currentRallyEntry.attack_type === 'DIRECT') ? null : 'DIRECT';
        updateInputDisplay();
    });
    uiElements.btnTwoAttack.addEventListener('click', () => {
        resetTossQualityStates();
        if (currentRallyEntry.attack_type === 'TWO_ATTACK') {
            currentRallyEntry.attack_type = null;
        } else {
            currentRallyEntry.attack_type = 'TWO_ATTACK';
            currentRallyEntry.setter_id = currentRallyEntry.spiker_id || currentSetterId;
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
/** E. スコアボード操作 (修正版) */
function setupScoreboardEvents() {
    // 自チーム +
    uiElements.btnSelfPlus.addEventListener('click', () => {
        if (!GameManager.state.isOurServing) {
            GameManager.state.rotation = (GameManager.state.rotation % 6) + 1;
            updateSpikerUIRotation(GameManager.state.rotation);
        }
        GameManager.state.ourScore++;
        GameManager.state.isOurServing = true;
        GameManager.syncGlobals();
        UIManager.updateScoreboard();
    });
    // 自チーム -
    uiElements.btnSelfMinus.addEventListener('click', () => {
        GameManager.state.ourScore = Math.max(0, GameManager.state.ourScore - 1);
        GameManager.state.isOurServing = false; // 相手に移動(取り消し想定)
        GameManager.syncGlobals(); // ★重要
        UIManager.updateScoreboard();
    });
    // 相手チーム +
    uiElements.btnOppPlus.addEventListener('click', () => {
        GameManager.state.opponentScore++;
        GameManager.state.isOurServing = false;
        GameManager.syncGlobals(); // ★重要
        UIManager.updateScoreboard();
    });
    // 相手チーム -
    uiElements.btnOppMinus.addEventListener('click', () => {
        GameManager.state.opponentScore = Math.max(0, GameManager.state.opponentScore - 1);
        GameManager.state.isOurServing = true;
        GameManager.syncGlobals(); // ★重要
        UIManager.updateScoreboard();
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
    if (uiElements.btnConfirmSub) {
        uiElements.btnConfirmSub.addEventListener('click', () => {
            executeSubstitution(userSelectedInId, userSelectedOutId); 
            closeSubstitutionPopup(); 
            updateInputDisplay();
        });
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
            TimeoutManager.open(); 
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
        const A_RADIUS = 25;     // 半径
        const distSq = Math.pow(relativeX - A_CENTER_X, 2) + Math.pow(relativeY - A_CENTER_Y, 2);
        if (Math.sqrt(distSq) <= A_RADIUS) {
            finalPassQuality = 'A'; 
        } else if (relativeX >= 33 && relativeY <= 30) {
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
    // 不足しているグローバル情報を最終セット
    currentRallyEntry.match_id = currentMatchId;
    currentRallyEntry.set_number = currentSetNumber;
    currentRallyEntry.rotation_number = currentRotation;
    if (!currentRallyEntry.spiker_id || !currentRallyEntry.result) {
        UIManager.showFeedback('スパイカーと結果は必須です。');
        return;
    }
    if (currentRallyEntry.play_id) {
        try {
            const oldRecord = await db.rallyLog.get(currentRallyEntry.play_id);
            GameManager.applyScoreCorrection(oldRecord, currentRallyEntry);
            await db.rallyLog.put(currentRallyEntry);
            console.log(`【DB更新成功】Play ID: ${currentRallyEntry.play_id}`);
            UIManager.showFeedback('修正を保存しました。');
            resetCurrentEntry(); // フォームをリセットして新規モードに戻す
        } catch (err) {
            console.error('【修正保存失敗】', err);
        }
        return; // ここで終了
    }
    const pointDelta = GameManager.calcPointDelta(currentRallyEntry);
    let didOurTeamWin = null;
    if (pointDelta === 1) didOurTeamWin = true;
    if (pointDelta === -1) didOurTeamWin = false;
    try {
        const id = await db.rallyLog.add(currentRallyEntry);
        console.log(`【DB保存成功】Play ID: ${id}`);
        if (didOurTeamWin !== null) {
            processPointEnd(didOurTeamWin);
        }
        resetCurrentEntry();
    } catch (err) {
        console.error('【DB保存失敗】', err, currentRallyEntry);
    }
}

/**
 * 7. 「取消」または「追加」成功時に、入力ステートをリセットする
 */
function resetCurrentEntry() {
    currentRallyEntry = { ...defaultRallyEntry }; 
    currentRallyEntry.rally_id = currentRallyId; // ★現在のラリーID
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
    if (typeof resetAttackTypeStates === 'function') resetAttackTypeStates();
    if (uiElements.btnAdd) {
        uiElements.btnAdd.innerHTML = '追&nbsp;加';
        uiElements.btnAdd.style.backgroundColor = '';
    }
    updateInputDisplay(); // UIもリセット
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
    if (currentRallyEntry.attack_type === 'TWO_ATTACK') {
        currentRallyEntry.setter_id = playerId;
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
    if (liberoPairs.length > 0) {
        uiElements.liberoModalTitle.textContent = 'リベロ交代 (OUT)';
        const activePair = liberoPairs[0]; 
        const liberoObj = Object.values(testLiberos).find(l => l.id === activePair.liberoId);
        const originalPlayer = testPlayerList[activePair.playerOutId];
        if (!liberoObj || !originalPlayer) {
            UIManager.showFeedback("データエラーが発生しました。リベロ設定を確認してください。");
            return;
        }
        let html = `
            <div class="select-group">
                <label>OUTする選手 (リベロ)</label>
                <p style="font-size: 1.2em; font-weight: bold; color: yellow;">
                    [${liberoObj.jersey}] ${liberoObj.name}
                </p>
            </div>
            <div class="select-group">
                <label>INする選手 (元の選手)</label>
                <p style="font-size: 1.2em; font-weight: bold;">
                    [${originalPlayer.jersey}] ${originalPlayer.name}
                </p>
            </div>
            <p style="margin-top:10px; color:#ccc;">リベロをベンチに戻し、元の選手をコートに戻します。</p>
            <input type="hidden" id="libero-action-type" value="OUT">
            <input type="hidden" id="libero-out-target-id" value="${originalPlayer.id}">
        `;
        uiElements.liberoModalBody.innerHTML = html;
    } else {
        uiElements.liberoModalTitle.textContent = 'リベロ交代 (IN)';
        let mainLibero = testLiberos['L1'];
        if (!mainLibero) mainLibero = testLiberos['L2'];
        if (!mainLibero) mainLibero = Object.values(testLiberos)[0];
        if (!mainLibero) {
            UIManager.showFeedback("リベロが登録されていません。\n試合設定でリベロを選択してください。");
            return;
        }
        const backRowPlayers = getBackRowPlayers(); // 後衛選手リスト
        let html = `
            <div class="select-group">
                <label>INする選手</label>
                <p style="font-size: 1.2em; font-weight: bold;">
                    [${mainLibero.jersey}] ${mainLibero.name}
                </p>
            </div>
            <div class="select-group">
                <label for="select-libero-out">OUTする選手 (後衛)</label>
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
    const actionTypeInput = document.getElementById('libero-action-type');
    const actionType = actionTypeInput ? actionTypeInput.value : null; // "IN" or "OUT"
    const swapInId = document.getElementById('libero-swap-in-id'); // 長押し(リベロ同士の交代)用
    if (swapInId) {
        const newLiberoId = swapInId.value;
        const oldPair = liberoPairs[0];
        if (oldPair) {
            GameManager.updatePlayerStatus(oldPair.liberoId, null); // 旧リベロ -> ベンチ
            GameManager.updatePlayerStatus(newLiberoId, 'LB');      // 新リベロ -> コート
            liberoPairs = [{ liberoId: newLiberoId, playerOutId: oldPair.playerOutId }];
        }
    } 
    else if (actionType === 'OUT') {
        const targetOriginalPlayerId = document.getElementById('libero-out-target-id').value;
        const pairToRemove = liberoPairs.find(p => p.playerOutId === targetOriginalPlayerId);
        if (pairToRemove) {
            GameManager.updatePlayerStatus(pairToRemove.liberoId, null);
        }
        liberoPairs = liberoPairs.filter(p => p.playerOutId !== targetOriginalPlayerId);
        const originalPlayer = testPlayerList[targetOriginalPlayerId];
        const originalPos = originalPlayer.position || 'OH';
        GameManager.updatePlayerStatus(targetOriginalPlayerId, originalPos);
    } 
    else {
        const tapInId = document.getElementById('libero-in-id'); 
        const selectInId = document.getElementById('select-libero-in'); // 長押し時の選択
        const selectOutId = document.getElementById('select-libero-out');
        const liberoToIn = tapInId ? tapInId.value : (selectInId ? selectInId.value : null);
        const playerToOut = selectOutId ? selectOutId.value : null;
        if (liberoToIn && playerToOut) {
            liberoPairs = liberoPairs.filter(p => p.playerOutId !== playerToOut);
            liberoPairs.push({ liberoId: liberoToIn, playerOutId: playerToOut });
            GameManager.updatePlayerStatus(playerToOut, null); // 元の選手 -> ベンチ
            GameManager.updatePlayerStatus(liberoToIn, 'LB');  // リベロ -> コート
        }
    }
    updateSpikerUIRotation(currentRotation); // コート表示更新
    populateInGameDropdowns(); // ★追加: プルダウンの中身を更新
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
    uiElements.homeScreen.style.display = 'none';
    uiElements.recordScreen.style.display = 'none';
    uiElements.playersScreen.style.display = 'none';
    const analysisScreen = document.getElementById('analysis-screen');
    if(analysisScreen) analysisScreen.style.display = 'none';

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
            if(analysisScreen) analysisScreen.style.display = 'flex'; 
            break;
        case 'settings':
            if(uiElements.settingsScreen) uiElements.settingsScreen.style.display = 'block';
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
    const isOurServe = document.querySelector('input[name="first-serve"]:checked').value === 'our';
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
    const isOurServe = document.querySelector('input[name="first-serve"]:checked').value === 'our';
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
    updateSpikerUIRotation(currentRotation);
    updateScoreboardDisplay();
    updateScoreboardUI(); 
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
    if (rosterEntry.position_in_rotation >= 4 && tossArea === 'BACK') {
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
function handleMatchExitRequest() {
    const s1 = GameManager.state.ourScore;
    const s2 = GameManager.state.opponentScore;
    if (s1 === 0 && s2 === 0) {
        showMatchEndModal();
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
            .delete();-
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