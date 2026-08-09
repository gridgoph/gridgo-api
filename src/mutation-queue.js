export function createMutationQueue() {
  let tail = Promise.resolve();

  return function enqueueMutation(task) {
    const result = tail.then(task, task);
    tail = result.catch(() => {});
    return result;
  };
}
