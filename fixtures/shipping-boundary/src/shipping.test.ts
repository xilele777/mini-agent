import assert from 'node:assert/strict'
import test from 'node:test'
import { shippingCost } from './shipping.js'

test('不足 100 元收取运费', () => {
  assert.equal(shippingCost(99.99), 10)
})

test('恰好 100 元免运费', () => {
  assert.equal(shippingCost(100), 0)
})

test('超过 100 元保持免运费', () => {
  assert.equal(shippingCost(120), 0)
})
