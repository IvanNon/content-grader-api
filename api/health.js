module.exports = function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.status(200).json({
    status: "ok",
    version: "2.0",
    timestamp: new Date().toISOString(),
    apis: {
      firecrawl: !!process.env.FIRECRAWL_API_KEY,
      dataForSEO: !!process.env.DATAFORSEO_LOGIN,
      openai: !!process.env.OPENAI_API_KEY,
    },
  });
};
