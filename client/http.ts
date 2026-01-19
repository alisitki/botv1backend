// FAZ 7: Minimal Fetch Wrapper for Trading Bot API

import { ErrorResponse } from './types.js';

export class ApiError extends Error {
    constructor(public response: ErrorResponse, public status: number) {
        super(response.message || response.error);
        this.name = 'ApiError';
    }
}

export interface RequestOptions extends RequestInit {
    params?: Record<string, string | number | boolean>;
}

export class HttpClient {
    constructor(private baseUrl: string) {
        // Remove trailing slash if any
        this.baseUrl = baseUrl.replace(/\/$/, '');
    }

    private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
        const { params, ...fetchOptions } = options;

        let url = `${this.baseUrl}${path}`;
        if (params) {
            const searchParams = new URLSearchParams();
            Object.entries(params).forEach(([key, value]) => {
                searchParams.append(key, String(value));
            });
            url += `?${searchParams.toString()}`;
        }

        const response = await fetch(url, {
            ...fetchOptions,
            headers: {
                'Content-Type': 'application/json',
                ...fetchOptions.headers,
            },
        });

        if (!response.ok) {
            let errorData: ErrorResponse;
            try {
                errorData = await response.json();
            } catch {
                errorData = { error: 'UNKNOWN_ERROR', message: `Request failed with status ${response.status}` };
            }
            throw new ApiError(errorData, response.status);
        }

        if (response.status === 204) return {} as T;
        return response.json();
    }

    get<T>(path: string, params?: Record<string, string | number | boolean>) {
        return this.request<T>(path, { method: 'GET', params });
    }

    post<T>(path: string, body?: any) {
        return this.request<T>(path, {
            method: 'POST',
            body: body ? JSON.stringify(body) : undefined,
        });
    }

    delete<T>(path: string) {
        return this.request<T>(path, { method: 'DELETE' });
    }
}
