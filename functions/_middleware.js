export async function onRequest(context) {
  const auth = context.request.headers.get("Authorization");
  const pass = context.env.BASIC_PASS;

  if (!pass) {
    return new Response("Missing BASIC_PASS", { status: 500 });
  }

  if (!auth || !auth.startsWith("Basic ")) {
    return new Response("Authentication required", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Secure Energy Dashboard"'
      }
    });
  }

  let decoded = "";
  try {
    decoded = atob(auth.slice(6));
  } catch {
    return new Response("Invalid authentication", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Secure Energy Dashboard"'
      }
    });
  }

  const colonIndex = decoded.indexOf(":");
  const providedPass = colonIndex >= 0 ? decoded.slice(colonIndex + 1) : "";

  if (providedPass !== pass) {
    return new Response("Invalid credentials", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Secure Energy Dashboard"'
      }
    });
  }

  return context.next();
}
