import { NextResponse } from 'next/server';

export function middleware(request) {
  const { pathname } = request.nextUrl;

  const publicPaths = [
    '/login.html',
    '/api/login',
    '/favicon.ico'
  ];

  const publicPrefixes = [
    '/_next/',
    '/api/public/'
  ];

  const isPublic =
    publicPaths.includes(pathname) ||
    publicPrefixes.some(prefix => pathname.startsWith(prefix));

  if (isPublic) {
    return NextResponse.next();
  }

  const authCookie = request.cookies.get('site_auth')?.value;

  if (authCookie === 'ok') {
    return NextResponse.next();
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/login.html';
  loginUrl.searchParams.set('next', pathname);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    /*
      Protect everything except common static files and Vercel internals.
    */
    '/((?!.*\\.(?:css|js|png|jpg|jpeg|gif|webp|svg|ico|txt|xml|map|json)$).*)',
    '/'
  ]
};
