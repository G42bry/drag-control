'use strict';

const can = require('socketcan');
const { App, Screen, Button, Label } = require('/opt/oap/sdk');

// ============================================================================
// CHASSIS CAN & UDS CONFIGURATION
// ============================================================================
const CONFIG = {
  canInterface: 'can0',          // MGU internal CAN gateway
  diagTxId: 0x6F1,               // Diagnostic Tester -> Gateway
  vtgNodeAddr: 0x19,             // Transfer Case (VTG)
  dscNodeAddr: 0x29,             // DSC Module
  egsNodeAddr: 0x18,             // Transmission (xHP TCU)

  // PT-CAN Brake Pressure & Steering Wheel Release
  brakeCanId: 0x0A1,             // Brake pressure / pedal status frame
  steeringBtnCanId: 0x1D6,       // Steering wheel cruise buttons
  releaseBtnMask: 0x04           // Cruise CANCEL/RES button drops spoof & launches
};

let isRwdMode = false;
let isLaunchArmed = false;
let vtgHeartbeatTimer = null;
let brakeSpoofTimer = null;
let aliveCounter = 0;

const channel = can.createRawChannel(CONFIG.canInterface, true);
channel.start();

// BMW E2E CRC-8 Checksum
function calcBmwCrc8(dataBytes, crcInit = 0xFF) {
  let crc = crcInit;
  for (let i = 1; i < dataBytes.length; i++) {
    crc ^= dataBytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x1D) : (crc << 1);
      crc &= 0xFF;
    }
  }
  return crc ^ 0xFF;
}

// Send UDS Frame over Diagnostic Gateway (0x6F1)
function sendUdsFrame(targetAddr, payload) {
  const buf = Buffer.alloc(8, 0x00);
  buf = targetAddr;
  buf = payload.length;
  for (let i = 0; i < payload.length; i++) {
    buf[i + 2] = payload[i];
  }
  channel.send({ id: CONFIG.diagTxId, data: buf });
}

// Clear 4x4, DSC, and TCU faults so Launch Control is never blocked
function clearAllDrivetrainFaults() {
  [CONFIG.vtgNodeAddr, CONFIG.dscNodeAddr, CONFIG.egsNodeAddr].forEach((addr, idx) => {
    setTimeout(() => {
      sendUdsFrame(addr, [0x14, 0xFF, 0xFF, 0xFF]);
    }, idx * 40);
  });
}

// Toggle RWD Burnout Mode vs AWD Launch Mode
function setRwdMode(enable) {
  if (enable) {
    sendUdsFrame(CONFIG.vtgNodeAddr, [0x10, 0x03]); // Extended Session
    setTimeout(() => sendUdsFrame(CONFIG.vtgNodeAddr, [0x31, 0x01, 0x0F, 0x01]), 50); // Open VTG Clutch
    vtgHeartbeatTimer = setInterval(() => {
      sendUdsFrame(CONFIG.vtgNodeAddr, [0x3E, 0x80]); // Tester Present
    }, 1500);

    isRwdMode = true;
    statusLabel.setText('DRIVETRAIN: RWD BURNOUT MODE');
    rwdBtn.setText('SWITCH TO AWD (LAUNCH)');
  } else {
    clearInterval(vtgHeartbeatTimer);
    vtgHeartbeatTimer = null;

    sendUdsFrame(CONFIG.vtgNodeAddr, [0x31, 0x02, 0x0F, 0x01]); // Stop Routine
    setTimeout(() => sendUdsFrame(CONFIG.vtgNodeAddr, [0x11, 0x01]), 50); // Reset VTG
    setTimeout(() => clearAllDrivetrainFaults(), 300); // Auto-clear 4x4 code

    isRwdMode = false;
    statusLabel.setText('DRIVETRAIN: AWD READY');
    rwdBtn.setText('ENABLE RWD (BURNOUT)');
  }
}

// Arm 4700 RPM Launch Control Bypass (Spoofs Brake Pressure while on Line Lock)
function armLaunchBypass(arm) {
  if (arm) {
    clearAllDrivetrainFaults();

    brakeSpoofTimer = setInterval(() => {
      aliveCounter = (aliveCounter + 1) & 0x0F;
      const frame = Buffer.alloc(8, 0x00);

      frame = 0xF0 | aliveCounter; // Brake switch pressed + alive counter
      frame = 0x50;                // Spoofed ~80 bar brake pressure
      frame = 0x04;                // Valid status flag
      frame = calcBmwCrc8(frame);  // Valid CRC-8

      channel.send({ id: CONFIG.brakeCanId, data: frame });
    }, 10);

    isLaunchArmed = true;
    statusLabel.setText('LC ARMED: 4700 RPM READY (STEERING BTN TO LAUNCH)');
    launchBtn.setText('RELEASE / CANCEL LAUNCH');
  } else {
    if (brakeSpoofTimer) {
      clearInterval(brakeSpoofTimer);
      brakeSpoofTimer = null;
    }
    isLaunchArmed = false;
    statusLabel.setText('LAUNCH RELEASED');
    launchBtn.setText('ARM 4700 RPM LC BYPASS');
  }
}

// Instant Release when Cruise CANCEL/RES button is pressed
channel.addListener('onMessage', (msg) => {
  if (isLaunchArmed && msg.id === CONFIG.steeringBtnCanId) {
    if ((msg.data & CONFIG.releaseBtnMask) !== 0) {
      armLaunchBypass(false);
    }
  }
});

// ============================================================================
// IDRIVE 7 NATIVE UI
// ============================================================================
const app = new App({ id: 'drag-control-id7', title: 'Drag & Launch Control' });
const mainScreen = new Screen({ title: '4700 RPM Launch & RWD Control' });

const statusLabel = new Label({
  text: 'READY - SET DSC OFF & SPORT+',
  x: 60, y: 80, width: 800, height: 60
});

const launchBtn = new Button({
  text: 'ARM 4700 RPM LC BYPASS',
  x: 60, y: 180, width: 420, height: 110,
  onClick: () => armLaunchBypass(!isLaunchArmed)
});

const rwdBtn = new Button({
  text: 'ENABLE RWD (BURNOUT)',
  x: 520, y: 180, width: 420, height: 110,
  onClick: () => setRwdMode(!isRwdMode)
});

const clearCodesBtn = new Button({
  text: 'CLEAR TCU / DSC / VTG CODES',
  x: 60, y: 330, width: 880, height: 90,
  onClick: () => {
    clearAllDrivetrainFaults();
    statusLabel.setText('DRIVETRAIN CODES CLEARED');
  }
});

mainScreen.add(statusLabel, launchBtn, rwdBtn, clearCodesBtn);
app.setRootScreen(mainScreen);
app.start();
