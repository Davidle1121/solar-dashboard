export async function onRequest(context) {
  const { request, env, next } = context;
  const auth = request.headers.get('Authorization');
  const pass = env.BASIC_PASS;

  const headerName = 'WWW' + String.fromCharCode(45) + 'Authenticate';

  if (!auth) {
    return new Response('Authentication required', {
      status: 401,
      headers: { [headerName]: 'Basic realm="Secure Energy Dashboard"' }
    });
  }

  const spaceIndex = auth.indexOf(' ');
  const scheme = auth.slice(0, spaceIndex);
  const encoded = auth.slice(spaceIndex + 1);

  if (!encoded || scheme !== 'Basic') {
    return new Response('Invalid authentication', {
      status: 401,
      headers: { [headerName]: 'Basic realm="Secure Energy Dashboard"' }
    });
  }

  const decoded = atob(encoded);
  const colonIndex = decoded.indexOf(':');
  const providedPass = decoded.slice(colonIndex + 1);

  if (providedPass !== pass) {
    return new Response('Invalid credentials', {
      status: 401,
      headers: { [headerName]: 'Basic realm="Secure Energy Dashboard"' }
    });
  }

  return await next();
}
