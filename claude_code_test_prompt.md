# 残電 -ZANDEN- Playwrightテスト実装指示

## 前提

- テスト対象：`zanden_online.html`（単一HTMLファイル）
- Firebase Realtime DBで全プレイヤーの状態をリアルタイム同期
- Firebaseの設定はHTMLに直書き済み（別途設定不要）
- ホストだけがゲーム開始・アクション配布を操作できる
- プレイヤーごとに別ブラウザコンテキストが必要

---

## やってほしいこと

Playwrightをセットアップし、以下のテストシナリオを実装してください。

### セットアップ

```
npm init -y
npm install -D @playwright/test
npx playwright install chromium
```

HTMLファイルはローカルサーバーで配信してください。

```
npm install -D serve
```

`package.json` の scripts に以下を追加：

```json
"test": "playwright test",
"serve": "serve . -p 3000"
```

`playwright.config.ts` を作成し、`webServer` でローカルサーバーを自動起動する設定にしてください。

---

### テストシナリオ一覧

#### シナリオ1：ルーム作成と参加

```
- ブラウザコンテキストを4つ用意（player1〜4）
- player1がホストとして「CREATE ROOM」→ 4人を選択 → 名前入力 → ルームコード取得
- player2〜4が「JOIN ROOM」→ 同じルームコードで参加
- 全員のロビー画面にplayer1〜4の名前が表示されることを確認
```

#### シナリオ2：ゲーム開始

```
- シナリオ1の続き
- 全員がキャラクターを選択
- ホスト（player1）が「START GAME」を押す
- 全員のブラウザでゲーム画面に遷移することを確認
- 全員の手札が2枚であることを確認
- デッキ残数が42-(4×2)=34枚であることを確認
```

#### シナリオ3：Phase1〜Phase5（リーダー準備〜アクション配布）

```
- リーダーのブラウザにだけ「次のフェーズへ」ボタンが表示されることを確認
- 非リーダーのブラウザにはWAITINGバーが表示されることを確認
- リーダーがPhase1→2→3→4と進める
- Phase5でアクション配布モーダルが開くことを確認
- 同じカードを2人に割り当てようとするとエラーが出ることを確認
- 正しく配布するとPhase6に進むことを確認
```

#### シナリオ4：Phase6 アクション実行

```
- リーダーから時計回りの順番でアクションが実行されることを確認
  （leaderIdx=0なら 0→1→2→3の順）
- 電池生産：「ダイスを振る」ボタンを押すとアニメーション後に出目が表示される
- 電池生産：EXECUTEを押すと手札が増えることを確認
- 電池散策：同様にダイス（1〜3）で手札が増えることを確認
- 電力支援：対象を選択してカードを選択→渡すと相手の手札が増えることを確認
- 電力徴収：＋ボタンで合計2枚指定→EXECUTEで自分の手札が増えることを確認
- 再生産：廃棄枚数を指定→EXECUTEで手札が入れ替わることを確認
- ダイスを振らずにEXECUTEを押すと弾かれることを確認
```

#### シナリオ5：Phase7 電力消費

```
- 全プレイヤー順番に電力消費モーダルが表示されることを確認
- フル電池をクリックすると消費されて稼働継続することを確認
- 手札がフル電池のみの場合：空電池をクリックすると電池切れ状態になることを確認
- 電池切れ状態のプレイヤーの次ターンで「再起動」ボタンが表示されることを確認
- フル電池3枚選択→RESTARTで稼働状態に戻ることを確認
```

#### シナリオ6：チャット（アピールタイム）

```
- Phase4でpayer2がチャットを送信
- player1〜4全員のブラウザにメッセージが表示されることを確認
- クイックピルのボタンをクリックしてメッセージが送れることを確認
```

#### シナリオ7：ゲーム終了（山札切れ）

```
- Firebaseのデッキを直接空にする（db.ref('rooms/xxx/deck').set([])）
- 次のPhase7終了時にゲーム終了が発火することを確認
- 全員のブラウザでリザルト画面が表示されることを確認（WAITINGで止まらない）
- 稼働状態のプレイヤーが勝者として表示されることを確認
- フル電池が最多の稼働プレイヤーがMVPとして表示されることを確認
```

#### シナリオ8：ブラウザリロードからの復帰

```
- ゲーム中にplayer2のブラウザをリロード
- 画面上部にRECONNECT AVAILABLEバナーが表示されることを確認
- RECONNECTボタンを押すとゲーム画面に戻ることを確認
- 復帰後も手札・フェーズ・プレイヤー状況が正しく表示されることを確認
- DISMISSを押すとバナーが消えてlocalStorageがクリアされることを確認
```

---

## テスト実装時の注意事項

### Firebaseのクリーンアップ

各テスト前後にFirebaseのテストルームを削除してください。

```typescript
// fixture または beforeEach/afterEach で
const testRoomCode = 'TEST01';
await db.ref('rooms/' + testRoomCode).remove();
```

### 待機処理

Firebase同期には時間がかかるため、要素の出現を `waitForSelector` で待ってください。ポーリングは使わないでください。

```typescript
// NG
await page.waitForTimeout(2000);

// OK
await page.waitForSelector('#g-players-grid .player-card', { timeout: 10000 });
```

### 複数コンテキストの同期

アクション実行後、他プレイヤーの画面への反映を確認する際は、Firebase同期完了を待ってから検証してください。

```typescript
// ホストがアクション実行
await hostPage.click('button:has-text("EXECUTE")');

// 他プレイヤー画面への反映を待つ
await guestPage.waitForSelector('.hand-cards .hcard', { timeout: 10000 });
```

### ルームコード取得

```typescript
const roomCodeEl = await hostPage.waitForSelector('.room-code-display');
const roomCode = await roomCodeEl.textContent();
```

### 手札枚数の確認

```typescript
const handCards = await page.$$('.hand-cards .hcard');
expect(handCards.length).toBe(2);
```

### WAITINGバーの確認

```typescript
// WAITINGバーが表示されている
await expect(page.locator('#wait-bar')).toBeVisible();

// WAITINGバーが消えている（自分のターン）
await expect(page.locator('#wait-bar')).toBeHidden();
```

---

## ファイル構成（作成してほしいもの）

```
tests/
├── setup.ts          # Firebase接続・クリーンアップ共通処理
├── lobby.spec.ts     # シナリオ1〜2
├── phases.spec.ts    # シナリオ3〜5
├── chat.spec.ts      # シナリオ6
├── endgame.spec.ts   # シナリオ7
└── reconnect.spec.ts # シナリオ8
```

---

## 実行方法（最終的にこれで動くようにしてほしい）

```bash
# 全テスト実行
npm test

# シナリオ指定
npx playwright test lobby

# UIモードで実行（デバッグ用）
npx playwright test --ui

# レポート確認
npx playwright show-report
```
