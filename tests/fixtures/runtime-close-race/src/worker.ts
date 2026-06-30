type Env = {
  OTHER: Fetcher;
};

export default {
  fetch(_request: Request, env: Env) {
    return env.OTHER.fetch("https://runtime-close-race-other.test/ok");
  },
};
