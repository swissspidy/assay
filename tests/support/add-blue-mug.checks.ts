/**
 * A check set written with the builder (ADR 0019), for the Tiny Shop task "Add a Blue Mug to
 * my cart." Used by the matcher, watch and CLI tests; a user's file imports
 * `@swissspidy/assay/checks` instead of the source.
 */
import { checks, includes, like, network, node, probe, req } from '../../src/checks/index.ts';

export default checks(
  {
    id: 'tiny-shop/add-blue-mug-ts',
    instruction: 'Add a Blue Mug to my cart.',
    outcomes: 'Then the cart contains a Blue Mug',
  },
  [
    req('R1', 'The cart contains a Blue Mug', { quote: 'the cart contains a Blue Mug' })
      .check('The backend cart has a Blue Mug line.', probe('cart', '/items').like([{ name: 'Blue Mug' }]))
      .check(
        'The Blue Mug went through the cart API.',
        network
          .post('/api/cart/items')
          .status(200)
          .requestBody(like({ sku: 'MUG-BLUE' })),
        { onMissing: 'abstain' },
      ),
    req('R2', 'The shop confirms the Blue Mug was added', { kind: 'soft', quote: 'Add a Blue Mug' }).check(
      'A status message says the Blue Mug was added.',
      node('main').contains({ role: 'status', text: includes('Blue Mug added to cart') }),
    ),
  ],
);
