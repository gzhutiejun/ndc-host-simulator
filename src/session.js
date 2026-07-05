function createSession() {
  const session = {
    luno: null,
    tvn: 0,
    nextTvn() {
      session.tvn += 1;
      return session.tvn;
    },
    remember(parsed) {
      if (parsed && parsed.luno) session.luno = parsed.luno;
    },
  };
  return session;
}

module.exports = { createSession };
