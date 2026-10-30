import { debounceTime, switchMap, timer } from 'rxjs';

/**
 * Wait for silence before selecting the next request.
 * A raw query does not close an existing request until it passes debounceTime.
 * The source and request factories retain their own subscription behavior.
 */
export function createDebouncedSearch$(queries$, search, delay, scheduler) {
  return queries$.pipe(
    debounceTime(delay, scheduler),
    switchMap(search),
  );
}

/**
 * Select a waiting timer/request flow on every raw query.
 * A new raw query immediately closes the previous timer or request subscription.
 * Source completion lets the final timer/request finish; it does not flush the timer.
 */
export function createImmediateCancelSearch$(queries$, search, delay, scheduler) {
  return queries$.pipe(
    switchMap((query) => timer(delay, scheduler).pipe(
      switchMap(() => search(query)),
    )),
  );
}
