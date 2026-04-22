/**
 * API 표준 응답 헬퍼
 */

const headers = () => ({
    "Content-Type": "application/json",
    "X-Request-Id": crypto.randomUUID(),
});

/** 성공 응답 (단건) */
export function ok<T>(data: T, status = 200) {
    return Response.json({ data }, { status, headers: headers() });
}

/** 성공 응답 (목록 + 페이지네이션) */
export function paginated<T>(
    data: T[],
    pagination: { total: number; page: number; perPage: number },
) {
    return Response.json(
        {
            data,
            pagination: {
                total: pagination.total,
                page: pagination.page,
                per_page: pagination.perPage,
                total_pages: Math.ceil(pagination.total / pagination.perPage),
            },
        },
        { status: 200, headers: headers() },
    );
}

/** 에러 응답 */
export function error(code: string, message: string, status: number) {
    return Response.json(
        { error: { code, message } },
        { status, headers: headers() },
    );
}

/** 자주 쓰는 에러 단축 */
export const errors = {
    unauthenticated: () => error("UNAUTHENTICATED", "로그인이 필요합니다", 401),
    unauthorized: () => error("UNAUTHENTICATED", "로그인이 필요합니다", 401),
    forbidden: () => error("FORBIDDEN", "권한이 없습니다", 403),
    notFound: (resource = "리소스") => error("NOT_FOUND", `${resource}을(를) 찾을 수 없습니다`, 404),
    validationFailed: (message: string) => error("VALIDATION_FAILED", message, 400),
    badRequest: (message: string) => error("BAD_REQUEST", message, 400),
    conflict: (code: string, message: string) => error(code, message, 409),
    rateLimited: () => error("RATE_LIMITED", "요청 한도를 초과했습니다", 429),
    internal: () => error("INTERNAL", "서버 오류가 발생했습니다", 500),
};
