use std::{
    sync::atomic::{AtomicUsize, Ordering},
    thread,
};

/// A small bounded worker set, returning results in input order.
pub fn map<T: Sync, R: Send>(items: &[T], limit: usize, action: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    thread::scope(|scope| {
        let workers: Vec<_> = (0..limit.min(items.len()))
            .map(|_| {
                scope.spawn(|| {
                    let mut results = vec![];
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(item) = items.get(index) else { break };
                        results.push((index, action(item)));
                    }
                    results
                })
            })
            .collect();
        let mut results: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().expect("Git worker panicked"))
            .collect();
        results.sort_unstable_by_key(|(index, _)| *index);
        results.into_iter().map(|(_, result)| result).collect()
    })
}
