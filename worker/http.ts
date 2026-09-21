export interface AppRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface AppResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[]>;
}

export function appResponse(result: AppResponse): Response {
  const headers = new Headers({'Content-Type': 'application/json', 'Cache-Control': 'private, no-store'});
  for (const [name, value] of Object.entries(result.headers)) {
    if (Array.isArray(value)) {for (const item of value) headers.append(name, item);}
    else headers.set(name, value);
  }
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'same-origin');
  return new Response(result.body || null, {status: result.status, headers});
}
