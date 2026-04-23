#pragma once

void slotInit();    // reset game state (credits=10, idle)
void slotTick();    // render one frame to spr (no pushSprite)
void slotOnBtnA();  // spin / no-op if already spinning
