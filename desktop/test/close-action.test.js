const { test } = require("node:test");
const assert = require("node:assert/strict");
const { closeAction } = require("../close-action");

test("the close button hides the window while close to tray is on", () => {
  assert.equal(closeAction({ quitting: false, closeToTray: true }), "hide");
});

test("with close to tray off the close button quits the app", () => {
  // Closing just the window would leave the hidden tray flyout, and the app,
  // running.
  assert.equal(closeAction({ quitting: false, closeToTray: false }), "quit");
});

test("a quit already under way lets the window close", () => {
  assert.equal(closeAction({ quitting: true, closeToTray: true }), "close");
  assert.equal(closeAction({ quitting: true, closeToTray: false }), "close");
});
