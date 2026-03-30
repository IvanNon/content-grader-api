module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    status: "ok",
    version: "3.1",
    timestamp: new Date().toISOString(),
    signals: 32,
    features: ["real_google_rank"],
    apis: {
      firecrawl: !!process.env.FIRECRAWL_API_KEY,
      dataForSEO: !!process.env.DATAFORSEO_LOGIN,
      openai: !!process.env.OPENAI_API_KEY,
      googleApi: !!process.env.GOOGLE_API_KEY,
      serpApi: !!process.env.SERPAPI_KEY,
    },
  });
};
