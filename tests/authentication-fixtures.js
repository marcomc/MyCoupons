// Synthetic admission fixtures. Mixed messages are policy tests, not observed mail.
const authenticationMessages = [
  {subject: 'Sign in to Acme', text: 'Your code is 123456'},
  {text: 'Acme: Your verification code is ABCDEF'},
  {subject: 'Acme', html: '<h1>Your verification code</h1><p>123456 expires in 10 minutes</p>'},
  {text: 'Acme: 123456 is your verification code.'},
  {text: 'Acme: Your verification code is aBcDeF'},
  {text: 'Acme: Your one-time passcode is 123456'},
  {text: 'Acme: Use 123456 to confirm your email'},
  {text: 'Acme: Here is your verification code: aBcDeF'},
  {text: 'Acme: Here is your one-time passcode: 123456'},
  {text: 'Acme: This is your security passcode: aBcDeF'},
  {text: 'Acme: Use coupon passcode SAVE20 to verify your account.'},
  {text: 'Acme: Your coupon verification code is 123456'},
  {text: 'Acme: Your discount security passcode is aBcDeF'},
  {text: 'Acme: verify your account using coupon code SAVE20.'},
  {text: 'Acme: 123456 is your verification code for signing in.'},
  {text: 'Acme: Enter 123456 to sign in.'},
  {subject: 'Your verification code', text: 'Hello Acme,\nYour code is 123456'},
  {text: 'Acme: Unlike the example above, your verification code is 123456.'},
  {text: 'Acme: Read the example above; your verification code is 123456.'},
  {text: 'Acme: Unlike the example below, your verification code is 123456.'},
  {text: 'Acme verification code below: LOGIN77'},
  {text: 'Acme verification code shown below: LOGIN77'},
  {text: 'Your verification code is 123456'},
  {text: 'An example uses no real code. Your verification code is 123456'},
  {text: 'Documentation is available in the help center.\nYour verification code is 123456'},
  {html: '<p>Documentation is available in the help center.</p><p>Your verification code is 123456</p>'},
  {text: 'Codice di verifica: 123456'},
  {text: 'Il tuo codice di verifica monouso è 123456'},
  {text: 'Security code: 123456'},
  {text: 'Your OTP is 123456'},
  {text: 'Acme: enter code LOGIN77 to reset your password.'},
  {text: 'Acme: use code LOGIN77 to sign in.'},
  {text: 'Acme: verify your account using code LOGIN77.'},
  {text: 'Brand: coupon code SAVE20 to reset your password for 20% off.'},
  {text: 'Brand: one-time code SAVE20 for your order.'},
  {text: 'Brand: codice di verifica SAVE20 per il tuo acquisto.'},
  {text: 'Brand: usa il codice SAVE20 per verificare il tuo account.'},
  {subject: 'Your verification code', text: '123456\nEnter this code to verify your account.'},
  {subject: 'Your verification code', text: 'Use code 123456 to verify your account.\nBrand coupon code SAVE20'},
  {html: '<h2>Your verification code</h2><p>Use code 123456 to verify your account.</p><p>Brand coupon code SAVE20</p>'},
  {subject: 'Account: codice di verifica monouso', text: 'Inserisci il codice di verifica entro 20 minuti.\nDEMO123.\nIl codice scadrà fra 20 minuti.'},
  {subject: 'Account: codice di verifica monouso', text: 'Notifica codice di verifica. Inserisci il codice di verifica entro 20 minuti. DEMO123. Nota: il codice scadrà 20 minuti dalla consegna.'},
  {html: '<h1>Your verification code</h1><div>123456</div><p>Enter it to verify your account.</p>'},
  {text: 'Il tuo codice di verifica\n123456\nInseriscilo per accedere.'},
  {text: 'Brand coupon code SAVE20. Your verification code is 123456'},
  {subject: 'Your verification code', html: '<p>123456</p><p>Brand coupon code SAVE20</p><img src="https://images.example/offer.png">'}
];

// Small synthetic cross-product of the R5 association dimensions. All consumers
// share these cases; no example here is represented as observed private mail.
for (const code of ['123456', 'ABCDEF', 'abcdef', 'aBcDeF', 'LOGIN77', 'ÈTÉ+20!']) {
  for (const locale of [
    {subject: 'Sign in to Acme', label: 'your verification code', generic: 'Your code is ',
      copula: ' is ', expiry: ' expires in 10 minutes'},
    {subject: 'Reimposta la password', label: 'il tuo codice di verifica', generic: 'Il tuo codice è ',
      copula: ' è ', expiry: ' scadrà fra 10 minuti'}
  ]) {
    for (const continuation of ['', locale.expiry]) {
      authenticationMessages.push(
        {subject: locale.subject, text: locale.generic + code + continuation},
        {text: 'Acme: ' + locale.label + locale.copula + code + continuation},
        {text: 'Acme: ' + code + locale.copula + locale.label + continuation + '.'},
        {subject: locale.subject, text: locale.generic.trimEnd() + ': ' + code + continuation},
        {subject: locale.label, text: code + continuation},
        {html: '<h1>' + locale.label + '</h1><p>' + code + continuation + '</p>'}
      );
    }
  }
}
authenticationMessages.push(
  {text: '123456 is your verification code, valid for 10 minutes.'},
  {text: 'ABCDEF is your verification code and expires in 10 minutes.'},
  {subject: 'Sign in to Acme', text: '123456 is your code.'},
  {subject: 'Reimposta la password', text: 'ABCDEF è il tuo codice.'}
);
for (const label of ['code', 'passcode', 'coupon code', 'promo code', 'discount code', 'codice', 'codice sconto']) {
  authenticationMessages.push(
    {text: 'Acme: verify your account using ' + label + ' LOGIN77.'},
    {text: 'Acme: sign into your account with ' + label + ' LOGIN77.'},
    {text: 'Acme: use ' + label + ' LOGIN77 to sign in.'}
  );
}
for (const [verb, purpose] of [['Enter', 'to sign in'], ['Use', 'for verifying your account'], ['Inserisci', 'per accedere']]) {
  authenticationMessages.push({text: 'Acme: ' + verb + ' ABCDEF ' + purpose + '.'});
}
for (const code of ['123456', 'aBcDeF']) {
  authenticationMessages.push(
    {text: 'Acme: Your security passcode is ' + code},
    {text: 'Acme: ' + code + ' is your one-time passcode.'},
    {subject: 'Your one-time passcode', text: 'Hello Acme,\nYour code is ' + code},
    {text: 'Acme: usa ' + code + ' per confermare la tua email.'},
    {text: 'Acme: Confirm your account using code ' + code}
  );
}

const ordinaryMessages = [
  // R10 explicitly limits generic verification verbs to authentication objects.
  {text: 'Acme: use code LOGIN77 to verify your order. Brand coupon code SAVE20'},
  {text: 'Acme: use code SAVE to verify your order. Brand coupon code SAVE20'},
  {text: 'Acme: use code LOGIN77 to verify your cart at checkout. Brand coupon code SAVE20'},
  {text: 'Brand: discount passcode SAVE20. Brand coupon code SAVE20'},
  {text: 'Brand: coupon passcode SAVE20 for your order. Brand coupon code SAVE20'},
  {text: 'Your verification code is ready. Brand coupon code SAVE20'},
  {text: 'Your verification code is pending. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA! is only described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA. is merely discussed in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA! is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Verification code 2FA. is described in our documentation. Brand coupon code SAVE20'},
  {text: 'Your verification code is available. Brand coupon code SAVE20'},
  {text: 'Your verification code is sent separately. Brand coupon code SAVE20'},
  {text: 'Your verification code is Required. Brand coupon code SAVE20'},
  {text: 'Your verification code is Sent separately. Brand coupon code SAVE20'},
  {text: 'Brand: use SAVE20 to confirm your order with 20% off.'},
  {text: 'Brand: usa SAVE20 per confermare il tuo ordine.'},
  {text: 'To troubleshoot, read the example below; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'See the example below, your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Consult the example below; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Troubleshoot your verification code: https://help.acme.example/article/12345. Brand coupon code SAVE20'},
  {text: 'Troubleshoot your verification code: help123@acme.example. Brand coupon code SAVE20'},
  {text: 'For example, your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Example; your verification code is 123456. Brand coupon code SAVE20'},
  {text: 'Brand: use SAVE20 to save on your order.'},
  {text: 'Brand: log in and redeem coupon code SAVE20 at checkout.'},
  {text: 'Brand: After login, get 20% off using coupon code SAVE20'},
  {subject: 'Your verification code', text: 'Hello Acme,\n123456 orders used coupon code SAVE20'},
  {subject: 'Your verification code', text: 'Hello Acme,\nBrand coupon code SAVE20'},
  {subject: 'Sign in to save', text: 'Your code is SAVE20'},
  {text: 'Your verification code is SENT separately. Brand coupon code SAVE20'},
  {text: 'Your verification code is ABCDEF (example). Brand coupon code SAVE20'},
  {text: 'ABCDEF is your verification code (example). Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>ABCDEF (example)</p><p>Brand coupon code SAVE20</p>'},
  {subject: 'Sign in to Acme', text: 'Brand: use code SAVE20 to get 20% off'},
  {subject: 'Sign in to Acme', text: 'Example: Your code is 123456. Brand coupon code SAVE20'},
  {subject: 'Login for discounts', text: 'Brand: Your code is SAVE20 for 20% off'},
  {subject: 'Sign in to Acme for discounts', text: 'Brand: Your code is SAVE20'},
  {subject: 'Sign in to Acme', text: 'Brand: coupon code is SAVE20'},
  {text: 'Example: ABCDEF is your verification code. Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>is required before checkout.</p><p>123456 orders use Brand coupon code SAVE20</p>'},
  {subject: 'Sign in to Acme', html: '<h2>Example</h2><p>Your code is ABCDEF</p><p>Brand coupon code SAVE20</p>'},
  {text: 'REQUIRED is your verification code status. Brand coupon code SAVE20'},
  {html: '<h1>Your verification code</h1><p>REQUIRED before checkout</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Brand: Log in to your account and use code SAVE20 to get 20% off'},
  {text: 'Brand: verification code is required before checkout. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED before checkout. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED. Coupon code SAVE20'},
  {text: 'Your verification code is REQUIRED to verify your account. Brand coupon code SAVE20'},
  {text: 'Il codice di verifica è NECESSARIO per verificare il tuo account. Brand coupon code SAVE20'},
  {text: 'Your verification code\nis required before checkout.\nCoupon code\nSAVE20'},
  {html: '<h1>Your verification code</h1><p>is required before checkout.</p><p>Coupon code</p><p>SAVE20</p>'},
  {subject: 'Example: Your verification code', text: '123456\nBrand coupon code SAVE20'},
  {subject: 'Example: Your verification code', text: 'Use code 123456 to verify your account.\nBrand coupon code SAVE20'},
  {html: '<h2>Example: Your verification code</h2><p>Use code 123456 to verify your account.</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Documentation example:\nYour verification code\n123456\nCoupon code SAVE20'},
  {html: '<h1>Documentation example</h1><h2>Your verification code</h2><pre>123456</pre><p>Coupon code SAVE20</p>'},
  {text: 'Brand: your verification code expires shortly. Coupon code SAVE20'},
  {text: 'Brand: il codice di verifica scadrà. Codice sconto SAVE20'},
  {text: 'Brand: example verification code: 123456. Coupon code SAVE20'},
  {text: 'Brand: codice di verifica di esempio: 123456. Codice sconto SAVE20'},
  {text: 'Brand: Your verification code is CODE_HERE. Coupon code SAVE20'},
  {text: 'Brand: OTP documentation for your account. Coupon code SAVE20'},
  {text: 'Brand: coupon code SAVE20 after login.'},
  {text: 'Brand: log in and apply code SAVE20 at checkout.'},
  {text: 'Brand: 20% off with code SAVE20 after login.'},
  {text: 'Brand promo: usa il codice SAVE20 dopo accesso.'},
  {subject: 'Your account', text: 'Brand coupon code SAVE20'},
  {sender: 'Your verification code: 123456', text: 'Brand coupon code SAVE20'},
  {html: '<!-- Your verification code: 123456 --><p>Brand coupon code SAVE20</p>'},
  {html: '<div hidden>Your verification code: 123456</div><p>Brand coupon code SAVE20</p>'}
];
// Cross-boundary roles, not just the reported spellings: same literal/label
// presented as actual issuance, an example, descriptive prose or a locator.
for (const noun of ['code', 'passcode']) {
  for (const code of ['123456', 'ABCDEF', 'abcdef', 'aBcDeF', 'MiXeD77']) {
    authenticationMessages.push(
      {subject: 'Your verification ' + noun, text: 'Hello Acme,\nYour ' + noun + ' is ' + code},
      {html: '<h1>Your verification ' + noun + '</h1><p>' + code + '</p>'},
      {text: 'Acme: use ' + noun + ' ' + code + ' to confirm your email.'},
      {subject: 'Confirm your email', text: 'Acme: ' + code + ' is your ' + noun + '.'}
    );
    ordinaryMessages.push(
      {text: 'For example, your verification ' + noun + ' is ' + code + '. Brand coupon code SAVE20'},
      {html: '<h1>Example: Your verification ' + noun + '</h1><p>' + code + '</p><p>Brand coupon code SAVE20</p>'}
    );
  }
  for (const value of ['2FA', '2FA!', '2FA.', 'Mechanism', 'https://help.example/123', 'help123@example.com']) {
    ordinaryMessages.push({text: 'Verification ' + noun + ' ' + value + ' is described in our documentation. Brand coupon code SAVE20'});
  }
}
// R8: representation-local frames and the related label/completion boundaries.
for (const noun of ['code', 'passcode', 'PIN']) {
  for (const code of ['123456', 'aBcDeF']) {
    const label = 'Your login ' + noun;
    authenticationMessages.push(
      {text: 'Acme: ' + label + ' is ' + code},
      {text: 'Acme: ' + code + ' is your login ' + noun + '.'},
      {subject: 'Sign in to Acme', text: 'Your ' + noun + ' is ' + code},
      {subject: 'Sign in to Acme', text: code + ' is your ' + noun + '.'},
      {text: 'Acme: use ' + noun + ' ' + code + ' to sign in.'},
      {text: 'Acme: verify your account using ' + noun + ' ' + code},
      {text: label + ' is\n' + code},
      {html: '<h1>' + label + ' is:</h1><p>' + code + '</p>'},
      {subject: label + ' is', text: code},
      {text: label + ' is ' + code + ' and should not be shared.'},
      {text: code + ' is your login ' + noun + ', do not share it.'},
      {html: '<h1>' + label + '</h1><p>' + code + ' must not be shared.</p>'}
    );
    ordinaryMessages.push(
      {text: 'For example, ' + label + ' is ' + code + ' and should not be shared. Brand coupon code SAVE20'},
      {text: label + ' is\nrequired before checkout. Brand coupon code SAVE20'},
      {html: '<h1>' + label + ' is:</h1><p>described in documentation.</p><p>Brand coupon code SAVE20</p>'}
    );
  }
}
for (const tail of [' and must be kept secret.', '; never share it.', ' e non deve essere condiviso.', ' e non condividerlo.', ' e deve rimanere segreto.']) {
  authenticationMessages.push({text: 'Il tuo codice di verifica è 123456' + tail});
}
for (const heading of ['Your verification code', 'Your verification code is', 'Example:', 'Documentation example:']) {
  authenticationMessages.push({text: heading, html: '<p>Your verification code is 123456</p>'});
  ordinaryMessages.push({text: heading, html: '<p>SAVE20.</p><p>Brand coupon code SAVE20</p>'});
}
for (const text of [undefined, '', 'Unrelated greeting.', 'Your verification code\nUnrelated greeting.']) {
  authenticationMessages.push({text, html: '<h1>Your verification code is</h1><p>123456</p>'});
  ordinaryMessages.push({text, html: '<p>SAVE20.</p><p>Brand coupon code SAVE20</p>'});
}
authenticationMessages.push(
  {subject: 'Your verification code', text: 'Unrelated greeting.', html: '<p>123456</p>'},
  {subject: 'Example: Your verification code', text: 'Brand coupon code SAVE20', html: '<p>Unrelated greeting.</p><p>Your verification code is 123456</p>'},
  {text: 'Your verification code is\n123456', html: '<p>Example:</p>'},
  {text: 'Il tuo codice di verifica è:\n123456'},
  {html: '<h1>Il tuo codice di verifica è</h1><p>123456</p>'}
);
ordinaryMessages.push(
  {subject: 'Example: Your verification code', text: 'Unrelated greeting.', html: '<p>Your verification code is 123456</p><p>Brand coupon code SAVE20</p>'},
  {text: 'SAVE20.\nBrand coupon code SAVE20', html: '<h1>Your verification code</h1>'},
  {text: 'SAVE20.\nBrand coupon code SAVE20', html: '<h1>Example:</h1>'},
  {text: 'Your verification code is\nUnrelated greeting.\nSAVE20.\nBrand coupon code SAVE20'},
  {html: '<h1>Your verification code is</h1><p>Unrelated greeting.</p><p>SAVE20.</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Your verification code is 2FA and is described in documentation. Brand coupon code SAVE20'},
  {text: 'Your verification code is 2FA and represents a login mechanism. Brand coupon code SAVE20'},
  {text: 'Brand: Your product PIN is 123456. Brand coupon code SAVE20'},
  {text: 'Brand: Address PIN is 123456. Brand coupon code SAVE20'},
  {text: 'Brand: coupon PIN SAVE20 for your order. Brand coupon code SAVE20'},
  {text: 'Your login PIN is ready. Brand coupon code SAVE20'},
  {text: 'Your login PIN is help123@example.com. Brand coupon code SAVE20'},
  {text: 'Your login PIN is https://help.example/123. Brand coupon code SAVE20'}
);
// R9 grouping changes admission only; original coupon/evidence tokens stay exact.
for (const code of ['123 456', '12 3456', '1 2 3 4 5 6', '123\u00a0456', '123\u202f456', '１２３ ４５６', '"123 456"']) {
  authenticationMessages.push(
    {text: 'Acme: Your verification code is ' + code},
    {text: 'Acme: ' + code + ' is your security PIN.'},
    {text: 'Acme: Use the verification code to sign in:\n' + code},
    {html: '<p>Use your one-time passcode to sign in:</p><p>' + code + '</p>'},
    {text: 'Acme: Your verification code is ' + code + ' (valid for 10 minutes).'}
  );
  ordinaryMessages.push(
    {text: 'Example: Your verification code is ' + code + ' (valid for 10 minutes). Brand coupon code SAVE20'},
    {text: 'Verification code ' + code + ' is described in documentation. Brand coupon code SAVE20'}
  );
}
for (const [instruction, label] of [
  ['Use the verification code to sign in:', 'Your verification code is '],
  ['Enter your security passcode:', 'Your security passcode is '],
  ['Use your login PIN to sign in:', 'Your login PIN is '],
  ['Inserisci il codice di verifica per accedere:', 'Il tuo codice di verifica è ']
]) {
  authenticationMessages.push(
    {text: instruction + '\n123456'},
    {html: '<p>' + instruction + '</p><p>123456</p>'}
  );
  for (const tail of ['(valid for 10 minutes)', '[expires in 10 minutes]', '(must not be shared)', '(scadrà fra 10 minuti)', '(non condividerlo)']) {
    authenticationMessages.push({text: label + '123456 ' + tail});
  }
  ordinaryMessages.push(
    {text: 'Example: ' + instruction + '\n123456\nBrand coupon code SAVE20'},
    {text: instruction + '\nUnrelated greeting.\nSAVE20.\nBrand coupon code SAVE20'},
    {html: '<p>' + instruction + '</p><p>Unrelated greeting.</p><p>SAVE20.</p><p>Brand coupon code SAVE20</p>'},
    {text: instruction, html: '<p>SAVE20.</p><p>Brand coupon code SAVE20</p>'},
    {text: 'SAVE20.\nBrand coupon code SAVE20', html: '<p>' + instruction + '</p>'},
    {text: label + '123456 (example). Brand coupon code SAVE20'},
    {text: label + '123456 (valid for 10 minutes in this example). Brand coupon code SAVE20'},
    {text: label + '123456. (valid for 10 minutes in this example). Brand coupon code SAVE20'}
  );
}
authenticationMessages.push(
  {text: 'Your verification code is 123 456.'},
  {text: 'Your verification code is 123456 expires in 10 minutes. See documentation for help.'}
);
ordinaryMessages.push(
  {text: 'Your verification code is 12', html: '<p>3456</p><p>Brand coupon code SAVE20</p>'},
  {html: '<p>Your verification code is 12</p><p>3456</p><p>Brand coupon code SAVE20</p>'},
  {text: 'Use your coupon code at checkout:\nSAVE20.\nBrand coupon code SAVE20'},
  {text: 'Your verification code is 123 456 orders old. Brand coupon code SAVE20'},
  {text: 'Your verification code is 123456 (valid for 10 minutes. Brand coupon code SAVE20'},
  {text: 'Your verification code is 123456 (mechanism described elsewhere). Brand coupon code SAVE20'}
);
authenticationMessages.push(
  {text: 'Acme: Your verification code is "123 456".'},
  {text: 'Acme: Your verification code is "123 456"!'},
  {text: "Acme: Your verification code is '123 456'."},
  {text: 'Acme: Please use your verification code:\n123456'},
  {html: '<p>Please enter your login PIN:</p><p>123 456</p>'},
  {text: 'Per favore, inserisci il codice di verifica:\n123456'}
);
for (const instruction of [
  'Do not use your verification code here:',
  'Never enter your verification code here:',
  'We never ask you to enter your verification code here:',
  'Learn how to use your verification code:',
  'The manual says "Use your verification code":'
]) {
  ordinaryMessages.push(
    {text: instruction + '\nSAVE20.\nBrand coupon code SAVE20'},
    {html: '<p>' + instruction + '</p><p>SAVE20.</p><p>Brand coupon code SAVE20</p>'}
  );
  authenticationMessages.push({text: instruction + '\nYour verification code is 123456'});
}
for (const separator of ['; ', ', ', '. ', '\n']) {
  authenticationMessages.push(
    {text: 'Acme: Do not use your old code' + separator + 'your verification code is 123456'},
    {text: 'Acme: Learn how to use your old code' + separator + 'your verification code is 123456'}
  );
}
for (const location of ['here', 'below', 'above', 'now']) {
  ordinaryMessages.push(
    {text: 'Use your verification code ' + location + ':\nBrand coupon code SAVE20'},
    {text: 'Learn how to use your verification code ' + location + ':\nBrand coupon code SAVE20'}
  );
  authenticationMessages.push({text: 'Use your verification code ' + location + ':\n123456'});
}
ordinaryMessages.push(
  {text: 'Learn how to use your verification code 123456. Brand coupon code SAVE20'},
  {text: 'We never ask you to enter your verification code 123456. Brand coupon code SAVE20'}
);
authenticationMessages.push({text: 'Your verification code is HERE'});
for (const purpose of ['access your account', 'access the profile', 'verify your account', 'verify your identity',
  'verify your email', 'verify your phone number', 'verificare la tua identità']) {
  authenticationMessages.push(
    {text: 'Acme: Use code 123456 to ' + purpose},
    {text: 'Acme: ' + purpose + ' using code 123456'},
    {subject: purpose, text: 'Your code is 123456'}
  );
}
for (const purpose of ['access the shop', 'access your discount', 'verify your order', 'verify your cart',
  'verify the 20% discount is applied at checkout', 'verificare lo sconto']) {
  ordinaryMessages.push({text: 'Brand: Use code SAVE20 to ' + purpose + '. Brand coupon code SAVE20'});
}
for (const word of ['confidential', 'private', 'secret', 'temporary', 'unique', 'riservato', 'segreto']) {
  ordinaryMessages.push({text: 'Your verification code is ' + word + '. Brand coupon code SAVE20'});
}
for (const label of ['verification code', 'security passcode', 'login PIN']) {
  ordinaryMessages.push({text: 'This is not a ' + label + ': SAVE20. Brand coupon code SAVE20'});
  authenticationMessages.push({text: 'This is not a ' + label + ': SAVE20; your verification code is 123456'});
}
ordinaryMessages.push({text: 'Questo non è un codice di verifica: SAVE20. Brand coupon code SAVE20'});
for (const subject of ['Sign in to Acme', 'Your verification code']) {
  for (const label of ['verification code', 'security passcode', 'login PIN']) {
    ordinaryMessages.push({subject, text: 'This is not a ' + label + ': SAVE20. Brand coupon code SAVE20'});
    authenticationMessages.push({subject, text: 'This is not a ' + label + ': SAVE20; your verification code is 123456'});
  }
}
for (const purpose of ['verify your account discount is applied at checkout', 'verify your email discount',
  'access your account discount', 'verificare la tua identità promozionale']) {
  ordinaryMessages.push({text: 'Brand: Use code SAVE20 to ' + purpose + '. Brand coupon code SAVE20'});
}
for (const purpose of ['verify your account', 'access your account', 'verificare la tua identità']) {
  authenticationMessages.push({text: 'Acme: Use code 123456 to ' + purpose + ' and continue to checkout.'});
}
for (const qualifier of ['email confirmation', 'e-mail confirmation', 'MFA']) {
  for (const noun of ['code', 'passcode', 'PIN']) {
    const label = qualifier + ' ' + noun;
    authenticationMessages.push(
      {text: 'Acme: Your ' + label + ' is 123456'},
      {text: 'Acme: aBcDeF is your ' + label + '.'},
      {subject: 'Your ' + label, text: '123456'},
      {html: '<h1>Your ' + label + '</h1><p>123456 expires in 10 minutes.</p>'},
      {text: 'Use your ' + label + ':\n123456'},
      {text: 'Your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is "123 456".'},
      {text: 'This is not a ' + label + ': SAVE20; your ' + label + ' is 123456'},
      {text: 'Example: Your ' + label + ' is 123456.\nYour ' + label + ' is aBcDeF'}
    );
    ordinaryMessages.push(
      {text: 'Your ' + label + ' is confidential. Brand coupon code SAVE20'},
      {text: 'Example: Your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {subject: 'Sign in to Acme', text: 'This is not a ' + label + ': SAVE20. Brand coupon code SAVE20'},
      {text: 'Learn how to use your ' + label + '. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is https://example.com/help. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is help@example.com. Brand coupon code SAVE20'}
    );
  }
}
ordinaryMessages.push(
  {text: 'Your order confirmation code is 123456. Brand coupon code SAVE20'},
  {text: 'Your booking confirmation code is 123456. Brand coupon code SAVE20'},
  {text: 'Enable MFA for your account. Brand coupon code SAVE20'},
  {text: 'Email confirmation is required. Brand coupon code SAVE20'}
);
for (const label of ['verification code', 'MFA code', 'email confirmation code', 'login PIN']) {
  for (const prefix of ['Was your ', 'Is your ', 'You asked if your ', 'You said your ']) {
    ordinaryMessages.push({subject: 'Your verification code', text: prefix + label + ' 123456? Brand coupon code SAVE20'});
    authenticationMessages.push({text: prefix + label + ' 123456? Your verification code is 654321'});
  }
  for (const value of ['123456', 'aBcDeF', '"123 456"', 'ABC+12!']) {
    authenticationMessages.push({text: 'Use ' + value + ' as your ' + label + '. Brand coupon code SAVE20'});
  }
  ordinaryMessages.push(
    {text: 'Did you use 123456 as your ' + label + '? Brand coupon code SAVE20'},
    {text: 'Do not use 123456 as your ' + label + '. Brand coupon code SAVE20'},
    {text: 'Example: Use 123456 as your ' + label + '. Brand coupon code SAVE20'},
    {text: 'Use 123456 as your ' + label + ' example. Brand coupon code SAVE20'}
  );
}
for (const recipient of ['for your account', 'for your order', 'for your purchase', 'per il tuo account', 'per il tuo ordine', 'per il tuo acquisto']) {
  for (const value of ['SAVE20', 'SAVE20!']) {
    ordinaryMessages.push({subject: 'Your verification code', text: 'Your code is ' + value + ' ' + recipient + ' discount. Brand coupon code SAVE20'});
    authenticationMessages.push({subject: 'Your verification code', text: 'Your code is ' + value + ' ' + recipient});
  }
}
ordinaryMessages.push({text: 'Use SAVE20 as your coupon code. Brand coupon code SAVE20'});
for (const [open, close] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']]) {
  for (const separator of [', ', ': ', ' ']) {
    ordinaryMessages.push({text: 'You reported' + separator + open + 'Your verification code is 123456' + close + '. Brand coupon code SAVE20'});
    authenticationMessages.push({text: 'You reported' + separator + open + 'Your verification code is 123456' + close + '; your verification code is 654321'});
  }
}
ordinaryMessages.push({text: 'You reported: Your verification code is 123456. Brand coupon code SAVE20'});
authenticationMessages.push({text: 'You reported: Your verification code is 123456. Your MFA code is 654321'});
module.exports = {authenticationMessages, ordinaryMessages};
