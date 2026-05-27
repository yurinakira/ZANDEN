import { test, expect, cleanupRoom, createRoom, joinRoom, startGame, BASE_URL, fbGet } from './setup';
import { Page } from '@playwright/test';

const FIREBASE_DB_URL = 'https://zanden-game-default-rtdb.firebaseio.com';
const ACTION_TYPES = ['電池生産', '電池散策', '電力支援', '電力徴収', '再生産'];

async function setupGameToPhase1(browser: any): Promise<{ pages: Page[]; leaderPage: Page; leaderIdx: number; roomCode: string }> {
  const contexts = [];
  const pages: Page[] = [];
  for (let i = 0; i < 4; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(BASE_URL);
    contexts.push(ctx);
    pages.push(page);
  }

  const roomCode = await createRoom(pages[0], 'Player1', 4);
  await joinRoom(pages[1], roomCode, 'Player2');
  await joinRoom(pages[2], roomCode, 'Player3');
  await joinRoom(pages[3], roomCode, 'Player4');

  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.querySelectorAll('#lobby-player-list .player-list-item').length >= 4,
      { timeout: 20000 }
    )
  ));

  await startGame(pages);

  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 1'),
      { timeout: 15000 }
    )
  ));

  let leaderPage = pages[0];
  let leaderIdx = 0;
  for (let i = 0; i < pages.length; i++) {
    const hasBtn = await pages[i].locator('#g-controls button:has-text("次のフェーズへ")').isVisible().catch(() => false);
    if (hasBtn) { leaderPage = pages[i]; leaderIdx = i; break; }
  }

  return { pages, leaderPage, leaderIdx, roomCode };
}

// Phase1→Phase4まで進める
async function advanceToPhase4(leaderPage: Page, pages: Page[]) {
  await leaderPage.click('#g-controls button:has-text("次のフェーズへ")');
  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 4'),
      { timeout: 15000 }
    )
  ));
}

// Phase4→Phase6まで進める
async function advanceToPhase6(leaderPage: Page, pages: Page[]) {
  await leaderPage.click('#g-controls button:has-text("アクション配布へ")');
  await leaderPage.waitForSelector('#dist-modal.open', { timeout: 10000 });
  await leaderPage.click('#dist-modal button:has-text("CONFIRM & SEND")');
  await Promise.all(pages.map(p =>
    p.waitForFunction(
      () => document.getElementById('g-phase-badge')?.textContent?.includes('PHASE 6'),
      { timeout: 20000 }
    )
  ));
}

// ============================================================
// シナリオ: リーダーの引いたアクションカード表示（Phase 4）
// ============================================================
test.describe('シナリオ: Phase4リーダーアクションカード表示', () => {
  test('Phase4でリーダーのみ引いたアクションカードが表示される', async ({ browser }) => {
    const { pages, leaderPage, leaderIdx, roomCode } = await setupGameToPhase1(browser);
    try {
      await advanceToPhase4(leaderPage, pages);

      // リーダーはACTION CARDSエリアが表示される
      await expect(leaderPage.locator('#g-action-area')).toBeVisible({ timeout: 10000 });

      // タイトルが "DRAWN ACTIONS" を含む
      const title = await leaderPage.locator('#g-action-area h3').textContent({ timeout: 5000 });
      expect(title).toContain('DRAWN ACTIONS');

      // 4枚のアクションカードが表示される（4人ゲーム）
      const cards = leaderPage.locator('#g-action-cards .ac-card');
      await expect(cards).toHaveCount(4, { timeout: 5000 });

      // 各カードに既知のアクション種別が含まれる
      for (let i = 0; i < 4; i++) {
        const cardText = await cards.nth(i).textContent();
        const hasKnownType = ACTION_TYPES.some(t => cardText?.includes(t));
        expect(hasKnownType).toBe(true);
      }

      // 非リーダーはACTION CARDSエリアが表示されない
      const nonLeaderPages = pages.filter((_, i) => i !== leaderIdx);
      for (const p of nonLeaderPages) {
        await expect(p.locator('#g-action-area')).not.toBeVisible({ timeout: 5000 });
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('Phase6に進むとアクション配布後のカードに切り替わる', async ({ browser }) => {
    const { pages, leaderPage, leaderIdx, roomCode } = await setupGameToPhase1(browser);
    try {
      await advanceToPhase4(leaderPage, pages);
      await advanceToPhase6(leaderPage, pages);

      // Phase6ではACTION EXECUTIONタイトルになる
      await expect(leaderPage.locator('#g-action-area')).toBeVisible({ timeout: 10000 });
      const title = await leaderPage.locator('#g-action-area h3').textContent({ timeout: 5000 });
      expect(title).toContain('ACTION EXECUTION');

      // 全員のアクションエリアが表示される
      for (const p of pages) {
        await expect(p.locator('#g-action-area')).toBeVisible({ timeout: 10000 });
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});

// ============================================================
// シナリオ: Phase6 アクション実行の可視性
// ============================================================
test.describe('シナリオ: Phase6アクション実行の可視性', () => {
  test('非アクティブプレイヤーはwait-modalなしでフェーズ情報を確認できる', async ({ browser }) => {
    const { pages, leaderPage, leaderIdx, roomCode } = await setupGameToPhase1(browser);
    try {
      await advanceToPhase4(leaderPage, pages);
      await advanceToPhase6(leaderPage, pages);

      // アクション実行ボタンがあるページ（アクティブプレイヤー）を特定
      let activeIdx = -1;
      for (let i = 0; i < pages.length; i++) {
        const hasBtn = await pages[i].locator('#g-controls button:has-text("アクションを実行する")').isVisible().catch(() => false);
        if (hasBtn) { activeIdx = i; break; }
      }
      expect(activeIdx).toBeGreaterThanOrEqual(0);

      // 非アクティブプレイヤーの検証
      const nonActivePages = pages.filter((_, i) => i !== activeIdx);
      for (const p of nonActivePages) {
        // wait-modal が表示されていない
        await expect(p.locator('#wait-modal')).not.toBeVisible({ timeout: 5000 });

        // フェーズボックスにPHASE 6が表示されている
        const phaseText = await p.locator('#g-phase-box').textContent({ timeout: 5000 });
        expect(phaseText).toContain('PHASE 6');

        // 現在の実行者のアクション種別がフェーズボックスに表示される
        const hasActionType = ACTION_TYPES.some(t => phaseText?.includes(t));
        expect(hasActionType).toBe(true);

        // WAITING... テキストが表示される
        expect(phaseText).toContain('WAITING');
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });

  test('アクション実行後にログが全プレイヤーに表示される', async ({ browser }) => {
    const { pages, leaderPage, leaderIdx, roomCode } = await setupGameToPhase1(browser);
    try {
      await advanceToPhase4(leaderPage, pages);
      await advanceToPhase6(leaderPage, pages);

      // アクティブプレイヤーを特定
      let activePage: Page | null = null;
      for (const p of pages) {
        const hasBtn = await p.locator('#g-controls button:has-text("アクションを実行する")').isVisible().catch(() => false);
        if (hasBtn) { activePage = p; break; }
      }
      if (!activePage) { test.skip(); return; }

      // アクションモーダルを開く
      await activePage.click('#g-controls button:has-text("アクションを実行する")');
      await activePage.waitForSelector('#action-modal.open', { timeout: 10000 });

      const title = await activePage.locator('#am-title').textContent();
      const isDiceAction = title?.includes('電池生産') || title?.includes('電池散策');

      if (isDiceAction) {
        // ダイスを振ってEXECUTE
        await activePage.click('#am-content button:has-text("ダイスを振る")');
        await activePage.waitForFunction(
          () => {
            const v = document.getElementById('dice-val') || document.getElementById('dice-val2');
            return v && v.textContent !== '-';
          },
          { timeout: 10000 }
        );
        await activePage.click('#am-btns button:has-text("EXECUTE")');
      } else {
        // ダイス不要アクションはSKIP
        await activePage.click('#am-btns button:has-text("SKIP")');
      }

      await activePage.waitForFunction(
        () => !document.getElementById('action-modal')?.classList.contains('open'),
        { timeout: 10000 }
      );

      // 全プレイヤーのログに実行結果が表示される
      for (const p of pages) {
        const logText = await p.locator('#g-log').textContent({ timeout: 10000 });
        // ログに何らかのアクション記録がある
        const hasLog = ACTION_TYPES.some(t => logText?.includes(t)) || logText?.includes('スキップ');
        expect(hasLog).toBe(true);
      }
    } finally {
      await cleanupRoom(roomCode);
      for (const p of pages) await p.context().close();
    }
  });
});
