/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from '@jetstream/shared/client-logger';
import { HTTP } from '@jetstream/shared/constants';
import {
  ApiResponse,
  ListMetadataResult,
  ListMetadataResultRaw,
  MapOf,
  RetrieveResult,
  RetrieveResultRaw,
  SalesforceOrgUi,
} from '@jetstream/types';
import axios, { AxiosAdapter, AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios';
import parseISO from 'date-fns/parseISO';
import { isEmpty, isObject } from 'lodash';
import isString from 'lodash/isString';
import {
  getCacheItemFromExistingKey,
  getCacheItemHttp,
  getCacheKeyForHttp,
  saveCacheItemHttp,
  shouldCheckIfModified,
} from './client-data-cache';
import { SOBJECT_DESCRIBE_CACHED_RESPONSES } from './client-data-data-cached-responses';
import { errorMiddleware } from './middleware';

function getHeader(headers: MapOf<string>, header: string) {
  if (!headers || !header) {
    return null;
  }
  return headers[header] || headers[header.toLowerCase()];
}

const baseConfig: Partial<AxiosRequestConfig> = {};

export function initForElectron(adapter: AxiosAdapter) {
  // use MessagePort adapter for communicating with server
  baseConfig.adapter = adapter;
}

export function initForElectronWorker() {
  baseConfig.baseURL = 'http://localhost/worker';
  // use MessagePort adapter for communicating with server
  // baseConfig.adapter = adapter;
}

/** Use for API calls going to external locations */
export async function handleExternalRequest<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
  const axiosInstance = axios.create({ ...baseConfig, ...config });
  axiosInstance.interceptors.request.use(requestInterceptor({}));
  axiosInstance.interceptors.response.use(
    (response) => {
      logger.info(`[HTTP][RES][${response.config.method.toUpperCase()}][${response.status}]`, response.config.url, {
        response: response.data,
      });
      return response;
    },
    (error: AxiosError) => {
      logger.info('[HTTP][RESPONSE][ERROR]', error.name, error.message);
      let message = 'An unknown error has occurred';
      if (error.isAxiosError && error.response) {
        message = error.message || 'An unknown error has occurred';
      }
      throw new Error(message);
    }
  );
  const response = await axiosInstance.request<T>(config);
  return response;
}

export async function handleRequest<T = any>(
  config: AxiosRequestConfig,
  options: {
    org?: SalesforceOrgUi;
    targetOrg?: SalesforceOrgUi;
    mockHeaderKey?: string;
    useCache?: boolean;
    skipRequestCache?: boolean;
    skipCacheIfOlderThan?: number;
    useQueryParamsInCacheKey?: boolean;
    useBodyInCacheKey?: boolean;
  } = {}
): Promise<ApiResponse<T>> {
  if (options.mockHeaderKey && isString(options.mockHeaderKey)) {
    config.headers = config.headers || {};
    config.headers[HTTP.HEADERS.X_MOCK_KEY] = options.mockHeaderKey;
  }
  const axiosInstance = axios.create({ ...baseConfig, ...config });
  axiosInstance.interceptors.request.use(requestInterceptor(options));
  axiosInstance.interceptors.response.use(responseInterceptor(options), responseErrorInterceptor(options));
  const response = await axiosInstance.request<ApiResponse<T>>(config);
  return response.data;
}

/**
 * Handle requests
 * Add authentication and org info
 * Optionally returned cached response instead of actual response
 */
function requestInterceptor<T>(options: {
  org?: SalesforceOrgUi;
  targetOrg?: SalesforceOrgUi;
  useCache?: boolean;
  skipRequestCache?: boolean;
  skipCacheIfOlderThan?: number;
  useQueryParamsInCacheKey?: boolean;
  useBodyInCacheKey?: boolean;
}) {
  return async (config: AxiosRequestConfig) => {
    logger.info(`[HTTP][REQ][${config.method.toUpperCase()}]`, config.url, { request: config });
    const { org, targetOrg, useCache, skipRequestCache, skipCacheIfOlderThan, useQueryParamsInCacheKey, useBodyInCacheKey } = options;
    // add request headers
    config.headers = config.headers || {};
    if (!config.headers[HTTP.HEADERS.ACCEPT]) {
      config.headers[HTTP.HEADERS.ACCEPT] = HTTP.CONTENT_TYPE.JSON;
    }

    if (org) {
      config.headers[HTTP.HEADERS.X_SFDC_ID] = org.uniqueId || '';
    }

    if (targetOrg) {
      config.headers[HTTP.HEADERS.X_SFDC_ID_TARGET] = targetOrg.uniqueId || '';
    }

    // IF mock response header exists and mock response exists, return data instead of making actual request
    if (config.headers[HTTP.HEADERS.X_MOCK_KEY] && SOBJECT_DESCRIBE_CACHED_RESPONSES[config.headers[HTTP.HEADERS.X_MOCK_KEY] as string]) {
      config.adapter = (config: AxiosRequestConfig) => {
        return new Promise((resolve) => {
          resolve({
            data: SOBJECT_DESCRIBE_CACHED_RESPONSES[config.headers[HTTP.HEADERS.X_MOCK_KEY] as string],
            status: 200,
            statusText: 'OK',
            headers: {},
            config,
          });
        });
      };
    } else if (useCache && org && !skipRequestCache) {
      // return cached response if available
      const cachedResults = await getCacheItemHttp<T>(config, org, useQueryParamsInCacheKey, useBodyInCacheKey);
      if (cachedResults) {
        /**
         * if skipCacheIfOlderThan is provided, then see if cache is older than provided date and skip cache if so
         */
        if (!skipCacheIfOlderThan || (Number.isFinite(skipCacheIfOlderThan) && cachedResults.age >= skipCacheIfOlderThan)) {
          // if cache is not super recent, then we should make a call to SFDC to see if the cache is still valid
          // we should share promise for any other requests for the same data, since it is common for duplicate requests
          // to be made for the same data

          /**
           * Describe calls are checked using a much shorter TTL to ensure we have the latest data
           * These still call out to Salesforce, but use the If-Modified-Since header to see if the data has changed.
           */
          if (shouldCheckIfModified(config.url, cachedResults.age)) {
            config.headers[HTTP.HEADERS.IF_MODIFIED_SINCE] = new Date(cachedResults.age).toUTCString();
            // This is passed back on the response to be able to know the exact cache key used without recalculating it
            config.headers[HTTP.HEADERS.X_CACHE_KEY] = getCacheKeyForHttp(config, useQueryParamsInCacheKey, useBodyInCacheKey);
            return config;
          }

          // return cached response
          config.adapter = async (config: AxiosRequestConfig) => {
            return new Promise((resolve) => {
              resolve({
                config,
                data: {
                  data: cachedResults.data,
                  cache: {
                    age: cachedResults.age,
                    exp: cachedResults.exp,
                    key: cachedResults.key,
                  },
                },
                headers: {
                  [HTTP.HEADERS.X_CACHE_RESPONSE]: '1',
                  [HTTP.HEADERS.X_CACHE_KEY]: cachedResults.key,
                  [HTTP.HEADERS.X_CACHE_AGE]: `${cachedResults.age}`,
                  [HTTP.HEADERS.X_CACHE_EXP]: `${cachedResults.exp}`,
                },
                status: 200,
                statusText: 'OK (CACHED)',
                request: {},
              });
            });
          };
        }
      }
    }

    return config;
  };
}

/**
 * Handle successful responses
 */
function responseInterceptor<T>(options: {
  org?: SalesforceOrgUi;
  useCache?: boolean;
  useQueryParamsInCacheKey?: boolean;
  useBodyInCacheKey?: boolean;
}): (response: AxiosResponse) => Promise<AxiosResponse<T>> {
  return async (response: AxiosResponse) => {
    const { org, useCache, useQueryParamsInCacheKey, useBodyInCacheKey } = options;

    /**
     * 299 indicates that Salesforce returned a 304 Not Modified response
     * This means that the cache is still valid, return the cached response and update the age/TTL
     */
    if (response.status === 299 && getHeader(response.headers, HTTP.HEADERS.X_CACHE_KEY)) {
      const cacheKey = getHeader(response.headers, HTTP.HEADERS.X_CACHE_KEY);
      // Also updates cache age and TTL
      const cachedResponse = await getCacheItemFromExistingKey<T>(cacheKey, org, true);
      if (cachedResponse) {
        response.data = cachedResponse;
        logger.info(`[HTTP][RES][${response.config.method.toUpperCase()}][CACHE][VALIDATED]`, response.config.url, {
          response: response.data,
        });
        return response;
      }
    }

    const cachedResponse = getHeader(response.headers, HTTP.HEADERS.X_CACHE_RESPONSE) === '1';
    if (cachedResponse) {
      logger.info(`[HTTP][RES][${response.config.method.toUpperCase()}][CACHE]`, response.config.url, { response: response.data });
    } else {
      logger.info(`[HTTP][RES][${response.config.method.toUpperCase()}][${response.status}]`, response.config.url, {
        response: response.data,
      });
    }

    const body: ApiResponse<T> = response.data;
    const responseData = body ? body.data : undefined;

    // if response should be cached and response came from server, save
    if (useCache && responseData && !cachedResponse) {
      const cacheItem = await saveCacheItemHttp<T>(responseData, response.config, org, useQueryParamsInCacheKey, useBodyInCacheKey);
      if (cacheItem) {
        body.cache = {
          age: new Date().getTime(),
          exp: cacheItem.exp,
          key: cacheItem.key,
        };
      }
    }
    return response;
  };
}

/**
 * Handle error responses
 */
function responseErrorInterceptor<T>(options: {
  org?: SalesforceOrgUi;
  useCache?: boolean;
  useQueryParamsInCacheKey?: boolean;
  useBodyInCacheKey?: boolean;
}) {
  return (error: AxiosError) => {
    const { org } = options;
    logger.info('[HTTP][RESPONSE][ERROR]', error.name, error.message);
    let message = 'An unknown error has occurred';
    if (error.isAxiosError && error.response) {
      const response = error.response as AxiosResponse<{ error: boolean; message: string }>;
      // Run middleware for error responses
      errorMiddleware.forEach((middleware) => middleware(response, org));
      const responseBody: { error: boolean; message: string } = response.data;
      message = responseBody.message || 'An unknown error has occurred';
      // take user to login page
      if (getHeader(response.headers, HTTP.HEADERS.X_LOGOUT) === '1') {
        // LOG USER OUT
        const logoutUrl = getHeader(response.headers, HTTP.HEADERS.X_LOGOUT_URL) || '/oauth/login';
        // stupid unit tests - location.href is readonly TS compilation failure
        // eslint-disable-next-line no-restricted-globals
        (location as any).href = logoutUrl;
      }
    }
    throw new Error(message);
  };
}

export function transformListMetadataResponse(items: ListMetadataResultRaw[]): ListMetadataResult[] {
  // metadata responses have variable return types because XML parsing is sketchy
  if (!Array.isArray(items)) {
    items = isEmpty(items) ? [] : [items];
  }
  return items.map((item) => ({
    ...item,
    createdDate: parseISO(item.createdDate),
    lastModifiedDate: parseISO(item.lastModifiedDate),
    // Some items, such as Settings do not include the property manageableState
    manageableState: item.manageableState || 'unmanaged',
  }));
}

export function transformRetrieveRequestResponse(item: RetrieveResultRaw): RetrieveResult {
  return {
    ...item,
    done: item.done === 'true',
    success: item.success === 'true',
    zipFile: isObject(item.zipFile) ? null : item.zipFile,
  };
}
