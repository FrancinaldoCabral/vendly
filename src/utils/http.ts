import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

export function createClient(baseURL: string, headers: Record<string, string> = {}): AxiosInstance {
  return axios.create({ baseURL, headers, timeout: 30_000 });
}

export async function safeRequest<T>(fn: () => Promise<T>): Promise<{ data: T } | { error: string }> {
  try {
    const data = await fn();
    return { data };
  } catch (err: unknown) {
    if (axios.isAxiosError(err)) {
      const msg = err.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      return { error: `HTTP ${err.response?.status ?? 'ERR'}: ${msg}` };
    }
    return { error: String(err) };
  }
}

export function toText(result: { data: unknown } | { error: string }): string {
  if ('error' in result) return `❌ Erro: ${result.error}`;
  return JSON.stringify(result.data, null, 2);
}
