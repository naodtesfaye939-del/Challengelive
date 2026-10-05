'use strict';
// Twitch rule 6.2.8: Bits may only unlock things defined by the Extension itself.
// So every Bits-powered dare is listed HERE. Viewers and streamers cannot type their own paid dares.
// The SKUs must match the products you create in the Twitch Developer Console.
const PAID_DARES = [
  { sku: 'dare_50_dance', bits: 50, title: 'Victory Dance', text: 'Do a 10-second victory dance' },
  { sku: 'dare_100_accent', bits: 100, title: 'Silly Accent', text: 'Talk in a silly accent for 2 minutes' },
  { sku: 'dare_200_draw', bits: 200, title: 'Left-Hand Art', text: 'Draw something with your non-dominant hand' },
  { sku: 'dare_300_alphabet', bits: 300, title: 'Backwards ABC', text: 'Say the alphabet backwards without a mistake' },
];

const GOAL_BOOSTS = [{ sku: 'goal_100', bits: 100, title: 'Boost the Goal' }];

// Major dares unlocked when the community goal fills up. The streamer only picks which one.
const MAJOR_DARES = [
  { id: 'major_party', title: 'Mega Dance Party', target: 1000, text: 'One full minute of freestyle dancing' },
  { id: 'major_artist', title: 'Chat Portrait', target: 2000, text: 'Draw a portrait of chat in 5 minutes' },
  { id: 'major_hat', title: 'Silly Costume', target: 3000, text: 'Wear a silly costume for 30 minutes' },
];

module.exports = { PAID_DARES, GOAL_BOOSTS, MAJOR_DARES };
