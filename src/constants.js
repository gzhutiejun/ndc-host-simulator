const FS = String.fromCharCode(0x1c);
const GS = String.fromCharCode(0x1d);
const RS = String.fromCharCode(0x1e);
const ETX = String.fromCharCode(0x03);
const SO = String.fromCharCode(0x0e);
const SI = String.fromCharCode(0x0f);

const STATUS_DESCRIPTOR = {
  DEVICE_FAULT: '8',
  READY9: '9',
  READY_B: 'B',
  TERMINAL_STATE: 'F',
};

const T2C_CLASS = {
  '1': 'UnsolicitedStatus',
  '2': 'SolicitedStatus',
  '5': 'Exit',
  '6': 'UploadEJ',
};

const C2T_CLASS = {
  '1': 'TerminalCommand',
  '3': 'DataCommand',
  '4': 'TransactionReply',
  '8': 'EMVConfig',
};

const SUBCLASS = {
  '1': 'TransactionRequest',
  '2': 'StatusMessage',
};

module.exports = {
  FS, GS, RS, ETX, SO, SI,
  STATUS_DESCRIPTOR, T2C_CLASS, C2T_CLASS, SUBCLASS,
};
