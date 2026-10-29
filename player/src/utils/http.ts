/**
 * HTTP 请求封装
 * 基于 axios 封装统一的请求/响应拦截、进度条、GET/POST 方法
 */
import axios, {
    AxiosInstance,
    AxiosResponse,
    InternalAxiosRequestConfig,
} from 'axios'
import NProgress from '@/config/nprogress'
import { inspectGatewayHeaders, markStreamFailure } from '@/utils/gatewayHealth'

/** 创建 axios 实例 */
const instance: AxiosInstance = axios.create({
    baseURL: import.meta.env.VITE_APP_BASE_API || '/api',
    timeout: 30000,
    withCredentials: true,
})

let pendingRequests = 0

const finishProgress = () => {
    pendingRequests = Math.max(0, pendingRequests - 1)
    if (pendingRequests === 0) NProgress.done()
}

/** 请求拦截器：启动进度条 */
instance.interceptors.request.use(
    (config: InternalAxiosRequestConfig) => {
        pendingRequests += 1
        if (pendingRequests === 1) NProgress.start()
        return config
    },
    (error) => Promise.reject(error)
)

/** 响应拦截器：结束进度条、感知网关降级状态、直接返回 data */
instance.interceptors.response.use(
    (response: AxiosResponse) => {
        const { data, headers } = response
        inspectGatewayHeaders(headers as any, data)

        finishProgress()
        return data
    },
    (error) => {
        if (error?.response) {
            inspectGatewayHeaders(error.response.headers, error.response.data)
            if (
                error.response.status === 503 &&
                (error.response.data?.degraded ||
                    error.response.data?.error?.code === 'STREAM_UNAVAILABLE_DEGRADED')
            ) {
                markStreamFailure('stream-degraded-fail')
            }
        }
        // 响应错误时也结束进度条
        finishProgress()
        return Promise.reject(error)
    }
)

/** GET 请求 */
export const httpGet = <T>(
    url: string,
    params?: object,
    config?: { signal?: AbortSignal }
): Promise<T> =>
    instance.get<T, T>(url, { params, ...config }) as unknown as Promise<T>

/** POST 请求 */
export const httpPost = <T>(
    url: string,
    data?: object,
    header?: object
): Promise<T> => instance.post<T, T>(url, data, header) as unknown as Promise<T>

/** 文件上传（multipart/form-data） */
export const httpUpload = <T>(
    url: string,
    formData: FormData,
    header?: object
): Promise<T> => {
    return instance.post<T, T>(url, formData, {
        headers: {
            'Content-Type': 'multipart/form-data',
            ...header,
        },
    }) as unknown as Promise<T>
}