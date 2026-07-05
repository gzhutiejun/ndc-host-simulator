// Go-In-Service terminal command: class '1' (TerminalCommand), command code '1'.
// 结构: "1" + FS + <空 LUNO 字段> + FS + <空字段> + FS + "1"
module.exports = function goInService(parsed, session, helpers) {
  if (session) session.remember(parsed);
  return helpers.applyTemplate('1<FS><FS><FS>1', helpers.ctx);
};
