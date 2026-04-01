export default {
  async fetch(request, env) {
    const auth = request.headers.get("Authorization");
    const pass = env.BASIC_PASS;

    if (!pass) {
      return new Response("Missing BASIC_PASS env var", { status: 500 });
    }

    if (!auth || !auth.startsWith("Basic ")) {
      return new Response("Authentication required", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Secure Energy Dashboard"' }
      });
    }

    const decoded = atob(auth.slice(6));
    const providedPass = decoded.slice(decoded.indexOf(":") + 1);

    if (providedPass !== pass) {
      return new Response("Invalid credentials", {
        status: 401,
        headers: { "WWW-Authenticate": 'Basic realm="Secure Energy Dashboard"' }
      });
    }

    // ✅ Authenticated — serve static assets
    return env.ASSETS.fetch(request);
  }
};
