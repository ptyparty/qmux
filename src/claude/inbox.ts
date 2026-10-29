export function deliver(socket: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Bun.connect({
      unix: socket,
      socket: {
        open(connection) {
          connection.end(`${JSON.stringify({ text })}\n`);
          resolve();
        },
        data() {},
        error(_connection, error) {
          reject(error);
        },
      },
    }).catch(reject);
  });
}
