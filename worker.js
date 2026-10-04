export default {
  async fetch(request, env) {
    try {
      const result = await env.DB
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all();

      return new Response(
        JSON.stringify({
          success: true,
          database: "connected",
          tables: result.results
        }),
        {
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          success: false,
          error: error.message
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json"
          }
        }
      );
    }
  }
};
