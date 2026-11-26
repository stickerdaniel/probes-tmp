(() => {
  let port;
  function connect() {
    const connected = chrome.runtime.connect({ name: 'stream' });
    connected.onDisconnect.addListener(() => {
      if (port === connected) port = undefined;
    });
    port = connected;
  }
  document.addEventListener('fixture-event', ({ detail }) => {
    const event = JSON.parse(detail);
    try {
      if (!port) connect();
      port.postMessage(event);
    } catch (error) {
      fetch('/content', {
        method: 'POST',
        body: JSON.stringify({ ...event, error: error.message }),
      }).catch(console.error);
    }
  });
  connect();
})();
