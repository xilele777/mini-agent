export function shippingCost(subtotal: number): number {
  return subtotal > 100 ? 0 : 10
}
