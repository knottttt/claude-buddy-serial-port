#include "slot_game.h"
#include <M5StickCPlus.h>

extern TFT_eSprite spr;

// ── symbols ────────────────────────────────────────────────────────────────
static const char*  SYM[7] = { "[7]", "|=|", "(@)", "/o\\", "$$$", "(O)", "###" };
static const int8_t PAY[7] = {  10,    5,     4,     3,      2,     2,    1    };

// ── state ──────────────────────────────────────────────────────────────────
enum SlotPhase : uint8_t { SP_IDLE, SP_SPIN, SP_STOP1, SP_STOP2, SP_STOP3, SP_RESULT };

static SlotPhase phase      = SP_IDLE;
static int16_t   credits    = 10;
static uint8_t   reel[3]    = {3, 5, 1};  // payline symbol index per reel
static uint32_t  nextTick   = 0;
static uint32_t  phaseTimer = 0;
static int8_t    lastWin    = 0;
static char      msg[24]    = "SPIN!";

// ── layout constants (portrait 135×240) ───────────────────────────────────
// Reel box: x=7..127, y=38..104  (w=121, h=67)
static const int BX  = 7,  BY  = 38, BW = 121, BH = 67;
static const int DX1 = 48, DX2 = 89;          // divider x (single-pixel VLine)
static const int PY1 = 60, PY2 = 82;          // payline border y

// symbol text top-left: textSize 2 → 12×16 px per char, 3 chars = 36 px wide
// reel zones: [8..47], [49..88], [90..126]
static const int SX[3] = { 9, 50, 90 };       // sym x per reel (centered in zone)
static const int SY[3] = { 41, 63, 85 };      // sym y: top row, payline, bottom row

// ── colors ─────────────────────────────────────────────────────────────────
static const uint16_t CY  = 0xFFE0;  // yellow  – title, payline borders
static const uint16_t CD  = 0x4208;  // dark grey – box, dim symbols, hint text
static const uint16_t CG  = TFT_GREEN;
static const uint16_t CR  = 0xF800;  // red
static const uint16_t CIN = 0xC618;  // light grey – credits, neutral status

// ── helpers ────────────────────────────────────────────────────────────────
static void drawSym(int reelIdx, int row, uint8_t symIdx, bool bright) {
    spr.setTextColor(bright ? TFT_WHITE : CD, TFT_BLACK);
    spr.setTextSize(2);
    spr.setCursor(SX[reelIdx], SY[row]);
    spr.print(SYM[symIdx]);
}

static void checkWin() {
    int r0 = reel[0], r1 = reel[1], r2 = reel[2];
    if (r0 == r1 && r1 == r2) {
        int w = PAY[r0]; credits += w; lastWin = w;
        snprintf(msg, sizeof(msg), "WIN!  +%d", w);
    } else if (r0 == 0 || r1 == 0 || r2 == 0) {
        credits++; lastWin = 1;
        snprintf(msg, sizeof(msg), "LUCKY! +1");
    } else {
        lastWin = 0;
        snprintf(msg, sizeof(msg), "NO LUCK");
    }
}

// ── public API ─────────────────────────────────────────────────────────────
void slotInit() {
    phase = SP_IDLE; credits = 10; lastWin = 0;
    reel[0] = 3; reel[1] = 5; reel[2] = 1;
    snprintf(msg, sizeof(msg), "SPIN!");
}

void slotOnBtnA() {
    if (phase != SP_IDLE) return;
    if (credits <= 0) { snprintf(msg, sizeof(msg), "NO COINS!"); return; }
    credits--;
    lastWin = 0;
    phase = SP_SPIN;
    nextTick   = millis();
    phaseTimer = millis() + 1200;   // spin 1.2 s before reel 1 stops
    msg[0] = '\0';
}

void slotTick() {
    uint32_t now = millis();

    // advance spinning reels every 80 ms
    if (now >= nextTick &&
        (phase == SP_SPIN || phase == SP_STOP1 || phase == SP_STOP2)) {
        nextTick = now + 80;
        if (phase == SP_SPIN)  { for (int i = 0; i < 3; i++) reel[i] = (reel[i]+1)%7; }
        if (phase == SP_STOP1) { reel[1]=(reel[1]+1)%7; reel[2]=(reel[2]+1)%7; }
        if (phase == SP_STOP2) { reel[2]=(reel[2]+1)%7; }
    }

    // phase transitions
    if      (phase == SP_SPIN  && now >= phaseTimer) { phase = SP_STOP1; phaseTimer = now+400; }
    else if (phase == SP_STOP1 && now >= phaseTimer) { phase = SP_STOP2; phaseTimer = now+400; }
    else if (phase == SP_STOP2 && now >= phaseTimer) { checkWin(); phase = SP_STOP3; phaseTimer = now+400; }
    else if (phase == SP_STOP3 && now >= phaseTimer) { phase = SP_RESULT; phaseTimer = now+1500; }
    else if (phase == SP_RESULT && now >= phaseTimer) {
        phase = SP_IDLE;
        snprintf(msg, sizeof(msg), credits > 0 ? "SPIN!" : "NO COINS!");
    }

    // ── render ──────────────────────────────────────────────────────────────
    spr.fillSprite(TFT_BLACK);

    // title
    spr.setTextColor(CY, TFT_BLACK);
    spr.setTextSize(2);
    spr.setTextDatum(TC_DATUM);
    spr.drawString("-- SLOTS --", 67, 8);
    spr.setTextDatum(TL_DATUM);

    // reel box & dividers
    spr.drawRect(BX, BY, BW, BH, CD);
    spr.drawFastVLine(DX1, BY, BH, CD);
    spr.drawFastVLine(DX2, BY, BH, CD);
    // payline highlight
    spr.drawFastHLine(BX, PY1, BW, CY);
    spr.drawFastHLine(BX, PY2, BW, CY);

    // symbols: each reel shows [above, payline, below]
    for (int r = 0; r < 3; r++) {
        drawSym(r, 0, (reel[r]+6)%7, false);  // above payline (dim)
        drawSym(r, 1,  reel[r],      true);   // payline (bright)
        drawSym(r, 2, (reel[r]+1)%7, false);  // below payline (dim)
    }

    // status message
    uint16_t msgCol = CIN;
    if (credits <= 0 && phase == SP_IDLE)    msgCol = CR;
    else if (phase == SP_RESULT || phase == SP_IDLE)
        msgCol = (lastWin > 0) ? CG : (phase == SP_RESULT ? CR : CIN);

    spr.setTextColor(msgCol, TFT_BLACK);
    spr.setTextSize(2);
    spr.setTextDatum(TC_DATUM);
    spr.drawString(msg, 67, 112);
    spr.setTextDatum(TL_DATUM);

    // credits
    char buf[20];
    snprintf(buf, sizeof(buf), "Credits: %d", (int)credits);
    spr.setTextColor(CIN, TFT_BLACK);
    spr.setTextSize(1);
    spr.setCursor(8, 140);
    spr.print(buf);

    // hint
    spr.setTextColor(CD, TFT_BLACK);
    spr.setCursor(8, 175);
    spr.print("[A]SPIN  [B]EXIT");
}
