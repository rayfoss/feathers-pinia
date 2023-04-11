/* eslint-disable @typescript-eslint/no-use-before-define */
import type { ComputedRef, Ref } from 'vue-demi'
import { computed, ref, unref, watch } from 'vue-demi'
import { _ } from '@feathersjs/commons'
import { useDebounceFn } from '@vueuse/core'
import stringify from 'fast-json-stable-stringify'
import { deepUnref, getExtendedQueryInfo, getQueryInfo } from '../utils'
import { convertData } from '../utils/convert-data'
import type { AnyData, ExtendedQueryInfo, Paginated, Params, Query } from '../types'
import { itemsFromPagination } from './utils'
import { usePageData } from './utils-pagination'
import type { UseFindGetDeps, UseFindOptions, UseFindParams } from './types'

export function useFind(params: ComputedRef<UseFindParams | null>, options: UseFindOptions = {}, deps: UseFindGetDeps) {
  const { pagination, debounce = 100, immediate = true, watch: _watch = true, paginateOnServer = false } = options
  const { service } = deps
  const { store } = service

  /** PARAMS **/
  const qid = computed(() => params.value?.qid || 'default')
  const limit = pagination?.limit || ref(params.value?.query?.$limit || 10)
  const skip = pagination?.skip || ref(params.value?.query?.$skip || 0)

  const paramsWithPagination = computed(() => {
    const query = deepUnref(params.value?.query || {})
    return {
      ...params.value,
      query: {
        ...query,
        $limit: limit.value,
        $skip: skip.value,
      },
    }
  })
  const paramsWithoutPagination = computed(() => {
    const queryShallowCopy = deepUnref({ ...(params.value?.query || {}) })
    const query = _.omit(queryShallowCopy, '$limit', '$skip')
    return { ...params.value, query }
  })

  /** REQUEST STATE **/
  const isPending = ref(false)
  const haveBeenRequested = ref(false)
  const haveLoaded = ref(false)
  const error = ref<any>(null)
  const clearError = () => (error.value = null)

  /** Cached Params **/
  const cachedParams = ref(deepUnref(params.value || {}))
  function updateCachedParams() {
    if (stringify(cachedParams.value) !== stringify(paramsWithPagination.value))
      cachedParams.value = paramsWithPagination.value
  }

  /** STORE ITEMS **/
  const data = computed(() => {
    if (paginateOnServer) {
      const values = itemsFromPagination(store, service, cachedParams.value)
      return values
    } else {
      const localParams = pagination ? paramsWithPagination.value : params.value || {}
      const result = service.findInStore(deepUnref(localParams)).data.value
      return result.filter((i: any) => i)
    }
  })
  const allLocalData = computed(() => {
    if (cachedQuery.value == null) return []

    // Pull server results for each page of data
    const pageKeys = Object.keys(_.omit(cachedQuery.value?.queryState, 'total', 'queryParams'))
    const pages = Object.values(_.pick(cachedQuery.value?.queryState, ...pageKeys))
    // remove possible duplicates (page data can be different as you browse between pages and new items are added)
    const ids = pages.reduce((allIds, page) => {
      page.ids.forEach((id: number | string) => {
        if (!allIds.includes(id)) allIds.push(id)
      })
      return allIds
    }, [])
    const matchingItemsById = _.pick(store.itemsById, ...ids)
    const result = Object.values(matchingItemsById)
    const converted = convertData(service, result)
    return converted
  })

  /** QUERY WHEN **/
  let queryWhenFn = () => true
  const queryWhen = (_queryWhenFn: () => boolean) => {
    queryWhenFn = _queryWhenFn
  }
  // returns cached query data from the store BEFORE the request is sent.
  const cachedQuery = computed(() => {
    const qidState: any = store.pagination[qid.value]
    if (!qidState) return null

    const queryInfo = getQueryInfo(cachedParams.value)
    const extendedInfo = getExtendedQueryInfo({ queryInfo, service, store, qid })
    return extendedInfo
  })

  const currentQuery = computed(() => {
    const qidState: any = store.pagination[qid.value]
    if (!qidState) return null

    const queryInfo = getQueryInfo(paramsWithPagination.value)
    const extendedInfo = getExtendedQueryInfo({ queryInfo, service, store, qid })
    return extendedInfo
  })

  /** QUERIES **/
  const queries: Ref<ExtendedQueryInfo[]> = ref([]) // query info after the response returns
  const latestQuery = computed(() => {
    return queries.value[queries.value.length - 1] || null
  })
  const previousQuery = computed(() => {
    return queries.value[queries.value.length - 2] || null
  })

  /** SERVER FETCHING **/
  const requestCount = ref(0)
  const request = ref<Promise<Paginated<AnyData>> | null>(null)

  // pulled into its own function so it can be called from `makeRequest` or `find`
  function setupPendingState() {
    // prevent setting pending state for cached ssr requests
    if (currentQuery.value?.ssr) return

    if (!haveBeenRequested.value) haveBeenRequested.value = true // never resets
    clearError()
    if (!isPending.value) isPending.value = true
    if (haveLoaded.value) haveLoaded.value = false
  }

  async function find(__params?: Params<Query>) {
    // When `paginateOnServer` is enabled, the computed params will always be used, __params ignored.
    const ___params = unref(paginateOnServer ? (paramsWithPagination as any) : __params)

    // if queryWhen is falsey, return early with dummy data
    if (!queryWhenFn()) return Promise.resolve({ data: [] as AnyData[] } as Paginated<AnyData>)

    setupPendingState()
    requestCount.value++

    try {
      const response = await service.find(___params as any)

      // Keep the two most-recent queries
      if (response.total) {
        const queryInfo = getQueryInfo(paramsWithPagination.value)
        const extendedQueryInfo = getExtendedQueryInfo({ queryInfo, service, store, qid })
        if (extendedQueryInfo) queries.value.push(extendedQueryInfo as unknown as ExtendedQueryInfo)
        if (queries.value.length > 2) queries.value.shift()
      }
      haveLoaded.value = true

      return response
    } catch (err: any) {
      error.value = err
      throw err
    } finally {
      isPending.value = false
    }
  }
  const findDebounced = useDebounceFn<any>(find, debounce)

  /** Query Gatekeeping **/
  const makeRequest = async () => {
    // If params are null, do nothing
    if (params.value === null) return

    if (!paginateOnServer) return

    // If we already have data for the currentQuery, update the cachedParams immediately
    if (currentQuery.value) updateCachedParams()

    // if the query passes queryWhen, setup the state before the debounce timer starts.
    if (queryWhenFn()) setupPendingState()

    request.value = findDebounced()
    await request.value

    // cache the params to update the computed `data``
    updateCachedParams()
  }

  /** Pagination Data **/
  const total = computed(() => {
    if (paginateOnServer) {
      return currentQuery.value?.total || 0
    } else {
      const count = service.countInStore(paramsWithoutPagination.value)
      return count.value
    }
  })
  const pageData = usePageData({ limit, skip, total, request })
  const { pageCount, currentPage, canPrev, canNext, toStart, toEnd, toPage, next, prev } = pageData

  /** Query Watching **/
  if (paginateOnServer && _watch) {
    watch(
      paramsWithPagination,
      () => {
        makeRequest()
      },
      { immediate: false },
    )

    if (immediate) makeRequest()

    // watch realtime events and re-query
    // TODO: only re-query when relevant
    service.on('created', () => {
      makeRequest()
    })
    service.on('patched', () => {
      makeRequest()
    })

    // if the current list had an item removed, re-query.
    service.on('removed', () => {
      // const id = item[service.store.idField]
      // const currentIds = data.value.map((i: any) => i[service.store.idField])
      // if (currentIds.includes(id))
      makeRequest()
    })
  }

  return {
    paramsWithPagination,
    isSsr: computed(() => {
      // hack: read total early during SSR to prevent hydration mismatch
      setTimeout(() => {
        ref(total.value)
      }, 0)
      return store.isSsr
    }), // ComputedRef<boolean>
    qid, // WritableComputedRef<string>

    // Data
    data, // ComputedRef<M[]>
    allLocalData, // ComputedRef<M[]>
    total, // ComputedRef<number>
    limit, // Ref<number>
    skip, // Ref<number>

    // Queries
    currentQuery, // ComputedRef<CurrentQuery<M> | null>
    cachedQuery, // ComputedRef<CurrentQuery<M> | null>
    latestQuery, // ComputedRef<QueryInfo | null>
    previousQuery, // ComputedRef<QueryInfo | null>

    // Requests & Watching
    find, // FindFn<M>
    request, // Ref<Promise<Paginated<M>>>
    requestCount, // Ref<number>
    queryWhen, // (queryWhenFn: () => boolean) => void

    // Request State
    isPending: computed(() => isPending.value), // ComputedRef<boolean>
    haveBeenRequested: computed(() => haveBeenRequested.value), // ComputedRef<boolean>
    haveLoaded: computed(() => haveLoaded.value), // ComputedRef<boolean>
    error: computed(() => error.value), // ComputedRef<any>
    clearError, // () => void

    // Pagination Utils
    pageCount, // Ref<number>
    currentPage, // Ref<number>
    canPrev, // ComputedRef<boolean>
    canNext, // ComputedRef<boolean>
    next, // () => Promise<void>
    prev, // () => Promise<void>
    toStart, // () => Promise<void>
    toEnd, // () => Promise<void>
    toPage, // (page: number) => Promise<void>
  }
}
