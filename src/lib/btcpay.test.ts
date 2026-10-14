/**
 * The link a customer is sent to for payment must be BTCPay's public address,
 * exactly: no internal host name and no internal port. A leftover port
 * (https://pay.<domain>:49392/...) broke every checkout on 13–14 Oct: the
 * browser blocked the redirect under form-action and the shopper stayed on the
 * checkout form while their order had already been placed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { publicLink } from './btcpay.js';

const PUB = 'https://pay.example.com';

test('the internal host and port are replaced by the public origin', () => {
  assert.equal(publicLink('http://generated_btcpayserver_1:49392/i/AbC123', PUB), 'https://pay.example.com/i/AbC123');
});

test('BTCPay telling us its public host with the internal port still yields a clean link', () => {
  assert.equal(publicLink('https://pay.example.com:49392/i/AbC123', PUB), 'https://pay.example.com/i/AbC123');
});

test('path, query and fragment survive', () => {
  assert.equal(publicLink('http://btcpay:49392/i/X?lang=en#top', PUB), 'https://pay.example.com/i/X?lang=en#top');
});

test('a public URL with a path keeps only its origin', () => {
  assert.equal(publicLink('http://btcpay:49392/i/X', 'https://pay.example.com/ignored/path'), 'https://pay.example.com/i/X');
});

test('without a public URL configured the link is left alone', () => {
  assert.equal(publicLink('http://btcpay:49392/i/X', undefined), 'http://btcpay:49392/i/X');
  assert.equal(publicLink('http://btcpay:49392/i/X', ''), 'http://btcpay:49392/i/X');
});
