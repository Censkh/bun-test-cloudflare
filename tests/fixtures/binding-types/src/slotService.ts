let requestCount = 0;

export default {
  fetch() {
    requestCount += 1;
    return Response.json({ requestCount });
  },
};
