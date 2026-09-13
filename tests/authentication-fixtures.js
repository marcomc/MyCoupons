// Synthetic admission fixtures. Mixed messages are policy tests, not observed mail.
const authenticationMessages = [
  {subject: 'Sign in to Acme', text: 'Your code is 123456'},
  {text: 'Acme: Your verification code is "ABCDEF"'},
  {subject: 'Acme', html: '<h1>Your verification code</h1><p>123456 expires in 10 minutes</p>'},
  {text: 'Acme: 123456 is your verification code.'},
  {text: 'Acme: Your verification code is "aBcDeF"'},
  {text: 'Acme: Your one-time passcode is 123456'},
  {text: 'Acme: Use 123456 to confirm your email'},
  {text: 'Acme: Here is your verification code: aBcDeF'},
  {text: 'Acme: Here is your one-time passcode: 123456'},
  {text: 'Acme: This is your security passcode: aBcDeF'},
  {text: 'Acme: Use coupon passcode SAVE20 to verify your account.'},
  {text: 'Acme: Your coupon verification code is 123456'},
  {text: 'Acme: Your discount security passcode is "aBcDeF"'},
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
for (const code of ['123456', '"ABCDEF"', '"abcdef"', '"aBcDeF"', 'LOGIN77', 'ÈTÉ+20!']) {
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
  {text: '"ABCDEF" is your verification code and expires in 10 minutes.'},
  {subject: 'Sign in to Acme', text: '123456 is your code.'},
  {subject: 'Reimposta la password', text: '"ABCDEF" è il tuo codice.'}
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
for (const code of ['123456', '"aBcDeF"']) {
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
  for (const code of ['123456', '"ABCDEF"', '"abcdef"', '"aBcDeF"', 'MiXeD77']) {
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
  for (const code of ['123456', '"aBcDeF"']) {
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
authenticationMessages.push({text: 'Your verification code is "HERE"'});
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
      {text: 'Acme: "aBcDeF" is your ' + label + '.'},
      {subject: 'Your ' + label, text: '123456'},
      {html: '<h1>Your ' + label + '</h1><p>123456 expires in 10 minutes.</p>'},
      {text: 'Use your ' + label + ':\n123456'},
      {text: 'Your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is "123 456".'},
      {text: 'This is not a ' + label + ': SAVE20; your ' + label + ' is 123456'},
      {text: 'Example: Your ' + label + ' is 123456.\nYour ' + label + ' is "aBcDeF"'}
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
  for (const value of ['123456', '"aBcDeF"', '"123 456"', 'ABC+12!']) {
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
for (const locator of ['help.acme.example/article/12345', '//help.acme.example/article/12345',
  'HELP.acme.example/article/12345', 'help.acme.example/a?x=1', 'https://help.acme.example/a']) {
  for (const value of [locator, '"' + locator + '"']) {
    ordinaryMessages.push({text: 'Troubleshoot your verification code: ' + value + '. Brand coupon code SAVE20'});
  }
}
for (const label of ['verification code', 'account access code', 'account access PIN']) {
  for (const purpose of ['to sign in', 'for signing in', 'to verify your account']) {
    for (const value of ['123456', '"aBcDeF"', '"123 456"']) {
      authenticationMessages.push(
        {text: 'Use the ' + label + ' ' + purpose + ': ' + value},
        {text: 'Use the ' + label + ' ' + purpose + ':' + value},
        {text: 'Your ' + label + ' ' + purpose + ' is ' + value},
        {html: '<h1>Your ' + label + ' ' + purpose + '</h1><p>' + value + '</p>'}
      );
    }
    ordinaryMessages.push(
      {text: 'Use the ' + label + ' ' + purpose + ': Brand coupon code SAVE20'},
      {text: 'Example: Use the ' + label + ' ' + purpose + ': 123456. Brand coupon code SAVE20'},
      {text: 'Do not use the ' + label + ' ' + purpose + ': 123456. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' ' + purpose + ' is confidential. Brand coupon code SAVE20'},
      {text: 'This is not a ' + label + ' ' + purpose + ': 123456. Brand coupon code SAVE20'}
    );
  }
  authenticationMessages.push({text: 'Your ' + label + ' is ABC.77!'});
  ordinaryMessages.push({text: 'Your ' + label + ' for your account discount is SAVE20. Brand coupon code SAVE20'});
}
ordinaryMessages.push(
  {text: 'Your promotional access code is SAVE20. Brand coupon code SAVE20'},
  {text: 'Your access code is SAVE20. Brand coupon code SAVE20'},
  {text: 'You reported: "Use the verification code to sign in: 123456". Brand coupon code SAVE20'},
  {text: 'Use the verification code to sign in:', html: '<p>123456</p><p>Brand coupon code SAVE20</p>'}
);
for (const label of ['Your verification code', 'OTP', 'Your account access PIN']) {
  for (const delimiter of [':', '=']) {
    for (const value of ['123456', '"aBcDeF"', '"123 456"', 'ABC:77!']) {
      authenticationMessages.push({text: label + delimiter + value + '. Brand coupon code SAVE20'});
    }
    ordinaryMessages.push(
      {text: 'Example: ' + label + delimiter + '123456. Brand coupon code SAVE20'},
      {text: 'This is not a ' + label + delimiter + '123456. Brand coupon code SAVE20'},
      {text: 'You reported: "' + label + delimiter + '123456". Brand coupon code SAVE20'},
      {text: label + delimiter + 'help.acme.example/article/12345. Brand coupon code SAVE20'}
    );
  }
}
for (const purpose of ['to verify your email', 'to access your account', 'for two-factor authentication',
  'for multi-factor authentication', 'for MFA', 'for MFA authentication', 'for 2FA']) {
  authenticationMessages.push(
    {text: '123456 is your code ' + purpose + '. Brand coupon code SAVE20'},
    {text: 'Use 123456 ' + purpose + '. Brand coupon code SAVE20'}
  );
  ordinaryMessages.push(
    {text: 'Example: 123456 is your code ' + purpose + '. Brand coupon code SAVE20'},
    {text: 'Did you use 123456 ' + purpose + '? Brand coupon code SAVE20'},
    {text: 'Do not use 123456 ' + purpose + '. Brand coupon code SAVE20'},
    {text: 'You reported: "123456 is your code ' + purpose + '". Brand coupon code SAVE20'}
  );
}
ordinaryMessages.push(
  {text: 'SAVE20 is your code to verify your account discount. Brand coupon code SAVE20'},
  {text: 'Use SAVE20 for two-factor authentication discount. Brand coupon code SAVE20'},
  {text: 'Use SAVE20 for MFA merchandise. Brand coupon code SAVE20'}
);
for (const noun of ['code', 'passcode', 'PIN', 'coupon code', 'promotional passcode', 'codice sconto']) {
  authenticationMessages.push({text: '123456 is your ' + noun + ' to verify your email. Brand coupon code SAVE20'});
  ordinaryMessages.push({text: 'You said 123456 is your ' + noun + ' to verify your email. Brand coupon code SAVE20'});
  authenticationMessages.push({text: 'You said 123456 is your ' + noun + ' to verify your email. Your verification code is 654321'});
}
ordinaryMessages.push({subject: 'Your verification code', text: 'SAVE20 is your coupon code. Brand coupon code SAVE20'});
for (const report of ['You said that ', 'You asked if ', 'You asked whether ']) {
  for (const noun of ['code', 'coupon code']) {
    ordinaryMessages.push({text: report + '123456 is your ' + noun + ' to verify your email. Brand coupon code SAVE20'});
    authenticationMessages.push({text: report + '123456 is your ' + noun + ' to verify your email. Your verification code is 654321'});
  }
}
for (const label of ['verification code', 'MFA code', 'account access PIN']) {
  authenticationMessages.push(
    {text: 'Your ' + label + ' will be 123456. Brand coupon code SAVE20'},
    {html: '<h1>Your ' + label + ' will be</h1><p>123456</p>'},
    {text: 'Your ' + label + ' to verify your email will be "aBcDeF"'}
  );
  ordinaryMessages.push(
    {text: 'Your ' + label + ' will be confidential. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' will not be 123456. Brand coupon code SAVE20'},
    {text: 'Example: Your ' + label + ' will be 123456. Brand coupon code SAVE20'},
    {text: 'You said that your ' + label + ' will be 123456. Brand coupon code SAVE20'},
    {text: 'If your ' + label + ' will be 123456, contact support. Brand coupon code SAVE20'}
  );
}
for (const noun of ['code', 'passcode', 'PIN', 'promotional passcode']) {
  for (const purpose of ['to sign in', 'to verify your email', 'for MFA']) {
    for (const separator of [': ', ':', ':\n']) {
      authenticationMessages.push({text: 'Use this ' + noun + ' ' + purpose + separator + '123456.'});
      ordinaryMessages.push({text: 'Example: Use this ' + noun + ' ' + purpose + separator + '123456.\nBrand coupon code SAVE20'});
    }
    ordinaryMessages.push(
      {text: 'Use this ' + noun + ' ' + purpose + ': Brand coupon code SAVE20'},
      {text: 'Do not use this ' + noun + ' ' + purpose + ': 123456. Brand coupon code SAVE20'},
      {text: 'You reported: "Use this ' + noun + ' ' + purpose + ': 123456". Brand coupon code SAVE20'}
    );
  }
}
ordinaryMessages.push(
  {text: 'Use this code to save 20%: SAVE20. Brand coupon code SAVE20'},
  {text: 'Use this code:\n123456.\nBrand coupon code SAVE20'},
  {text: 'Use this code to sign in:', html: '<p>123456</p><p>Brand coupon code SAVE20</p>'}
);
authenticationMessages.push(
  {text: 'Use this coupon code for MFA: 123456'},
  {text: '123456 will be your verification code.'},
  {text: 'Il tuo codice di verifica sarà 123456'},
  {text: '123456 sarà il tuo codice di verifica'},
  {text: 'Your verification code for MFA will be 123456'},
  {text: 'If your old verification code will be 123456, your verification code is 654321'}
);
ordinaryMessages.push(
  {text: 'Il tuo codice di verifica sarà riservato. Brand coupon code SAVE20'},
  {text: 'Use this code to sign in:\nUnrelated greeting.\n123456.\nBrand coupon code SAVE20'},
  {text: 'Use this code to sign in: confidential. Brand coupon code SAVE20'},
  {text: 'Use this code to sign in: help.acme.example/a. Brand coupon code SAVE20'}
);
for (const location of ['here', 'below', 'above']) {
  for (const purpose of ['to sign in', 'for MFA']) {
    ordinaryMessages.push(
      {text: 'Use this code ' + purpose + ': ' + location + '.\nBrand coupon code SAVE20'},
      {text: 'Use this code ' + purpose + ':\n' + location + '.\nBrand coupon code SAVE20'},
      {html: '<p>Use this code ' + purpose + ':</p><p>' + location + '.</p><p>Brand coupon code SAVE20</p>'}
    );
    authenticationMessages.push({text: 'Use this code ' + purpose + ':\n123456'});
  }
}
ordinaryMessages.push({text: 'If 123456 will be your verification code for MFA, contact support. Brand coupon code SAVE20'});
authenticationMessages.push(
  {text: 'Your verification code is "HERE"'},
  {text: 'Your verification code will be "HERE"'},
  {text: '123456 will be your verification code for MFA'},
  {text: 'If 123456 will be your verification code for MFA, your verification code is 654321'}
);
for (const label of ['one-time password', 'one time password', 'onetime password']) {
  authenticationMessages.push(
    {text: 'Your ' + label + ' is 123456'},
    {text: 'Your ' + label + '=123456. Brand coupon code SAVE20'},
    {html: '<h1>Your ' + label + '</h1><p>"aBcDeF"</p>'},
    {text: '123456 is your ' + label},
    {subject: 'Your ' + label, text: 'Your code is 123456'}
  );
  ordinaryMessages.push(
    {text: 'Your ' + label + ' is confidential. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is not 123456. Brand coupon code SAVE20'},
    {text: 'Example: Your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'Is your ' + label + ' 123456? Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' manager is available. Brand coupon code SAVE20'}
  );
}
ordinaryMessages.push({text: 'Your password is 123456. Brand coupon code SAVE20'});
for (const label of ['2FA code', 'two-factor code', 'two factor PIN', 'multi-factor passcode']) {
  authenticationMessages.push(
    {text: 'Your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' will be 123456'},
    {text: 'Your ' + label + ':123456'},
    {text: 'Use 123456 as your ' + label},
    {text: 'Example: Your ' + label + ' is 123456. Your ' + label + ' is 654321'},
    {html: '<h1>Your ' + label + '</h1><p>"aBcDeF"</p>'},
    {text: '123456 is your ' + label},
    {subject: 'Your ' + label, text: 'Your code is 123456'}
  );
  ordinaryMessages.push(
    {text: 'Your ' + label + ' is confidential. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is not 123456. Brand coupon code SAVE20'},
    {text: 'Example: Your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'You said that your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' manager is available. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is help.brand.example/a. Brand coupon code SAVE20'}
  );
}
for (const predicate of ['used', 'USED']) {
  for (const label of ['verification code', 'one-time password', '2FA code']) {
    ordinaryMessages.push(
      {text: 'A ' + label + ' is ' + predicate + ' to verify your account. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is ' + predicate + ' for MFA. Brand coupon code SAVE20'},
      {subject: 'Your ' + label, text: 'Your code is ' + predicate + ' to verify your account. Brand coupon code SAVE20'},
      {html: '<h1>Your ' + label + ' is</h1><p>' + predicate + ' to verify your account.</p><p>Brand coupon code SAVE20</p>'}
    );
    authenticationMessages.push({text: 'Use ' + predicate + ' as your ' + label},
      {text: 'Use code ' + predicate + ' to verify your account'});
  }
}
ordinaryMessages.push({text: 'Your 2FA is available. Brand coupon code SAVE20'});
for (const label of ['account recovery code', 'account-recovery code', 'account recovery PIN',
  'account-recovery PIN', 'account recovery passcode', 'account-recovery passcode']) {
  authenticationMessages.push(
    {text: 'Your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' will be 123456'},
    {text: 'Your ' + label + '=123456'},
    {text: '123456 is your ' + label},
    {text: 'Use 123456 as your ' + label},
    {subject: 'Your ' + label, text: 'Your code is "aBcDeF"'},
    {html: '<h1>Your ' + label + ':</h1><p>123456</p>'},
    {text: 'Example: Your ' + label + ' is 123456. Your ' + label + ' is 654321'}
  );
  ordinaryMessages.push(
    {text: 'Your ' + label + ' is confidential. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is used to verify your account. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is not 123456. Brand coupon code SAVE20'},
    {text: 'Example: Your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'You said that your ' + label + ' is 123456. Brand coupon code SAVE20'},
    {text: 'Is your ' + label + ' 123456? Brand coupon code SAVE20'},
    {text: 'If your ' + label + ' is 123456, contact support. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' manager is available. Brand coupon code SAVE20'},
    {text: 'Your ' + label + ' is help.brand.example/a. Brand coupon code SAVE20'}
  );
}
ordinaryMessages.push(
  {text: 'Your account recovery is available. Brand coupon code SAVE20'},
  {text: 'Your recovery code is 123456. Brand coupon code SAVE20'},
  {text: 'Read about account recovery. Use code SAVE20 to save 20%.'}
);
for (const issuer of ['Sample Bank', 'Example Shop', 'Tutorial Services', 'Documentation Store']) {
  authenticationMessages.push(
    {text: issuer + ': Your verification code is 123456'},
    {text: 'Your verification code is 123456. ' + issuer},
    {text: 'Your verification code is 123456 (valid for 10 minutes at ' + issuer + ')'},
    {subject: 'Sign in to ' + issuer, text: 'Your code is 123456'},
    {subject: issuer + ': Your verification code', text: 'Your code is 123456'},
    {html: '<h1>' + issuer + ': Your verification code</h1><p>123456</p>'}
  );
  ordinaryMessages.push(
    {text: issuer + ': For example, your verification code is 123456. Brand coupon code SAVE20'},
    {text: issuer + ': For example your verification code is 123456. Brand coupon code SAVE20'},
    {text: issuer + ': Example: Your verification code is 123456. Brand coupon code SAVE20'},
    {text: issuer + ': Your verification code is confidential. Brand coupon code SAVE20'}
  );
}
for (const marker of ['Example 1:', 'Sample 2:', 'Documentation says', 'Documentation states']) {
  ordinaryMessages.push(
    {text: marker + ' Your verification code is 123456. Brand coupon code SAVE20'},
    {html: '<p>' + marker + ' Your verification code is 123456.</p><p>Brand coupon code SAVE20</p>'}
  );
  if (marker.endsWith(':')) ordinaryMessages.push(
    {text: marker + '\nYour verification code is 123456. Brand coupon code SAVE20'},
    {html: '<h1>' + marker + '</h1><p>Your verification code is 123456.</p><p>Brand coupon code SAVE20</p>'}
  );
  authenticationMessages.push({text: marker + ' Your verification code is 123456. Your verification code is 654321'});
}
for (const issuer of ['Sample 123 Bank', 'Documentation 2 Services']) {
  authenticationMessages.push({text: issuer + ': Your verification code is 123456'});
  ordinaryMessages.push({text: issuer + ': Example 1: Your verification code is 123456. Brand coupon code SAVE20'});
}
// R20: bare words are ambiguous regardless of spelling or capitalization.
for (const value of ['incorrect', 'wrong', 'missing', 'unrecognized', 'abcdef', 'aBcDeF', 'HERE', 'ÈTÉ']) {
  for (const suffix of ['', '.', '!']) ordinaryMessages.push(
    {text: 'Your verification code is ' + value + suffix + '\nBrand coupon code SAVE20'},
    {text: 'Brand: ' + value + suffix + ' is your verification code. Brand coupon code SAVE20'},
    {subject: 'Your verification code', text: 'Your code is ' + value + suffix + '\nBrand coupon code SAVE20'}
  );
  for (const issued of ['Your verification code: ' + value, 'Your verification code is "' + value + '"',
    'Use code ' + value + ' to sign in', '"' + value + '" is your verification code']) {
    authenticationMessages.push({text: issued});
  }
  authenticationMessages.push({html: '<h1>Your verification code:</h1><p>' + value + '</p>'});
  for (const [open, close] of [['"', '"'], ["'", "'"], ['<', '>']]) {
    for (const suffix of ['.', '!', '?']) {
      authenticationMessages.push({text: 'Your verification code is ' + open + value + close + suffix + ' Brand coupon code SAVE20'});
      ordinaryMessages.push({text: 'Example: Your verification code is ' + open + value + close + suffix + ' Brand coupon code SAVE20'});
    }
    ordinaryMessages.push(
      {text: 'Your verification code is ' + open + value + '. Brand coupon code SAVE20'},
      {text: 'Your verification code is ' + value + close + '. Brand coupon code SAVE20'}
    );
  }
}
for (const purpose of ['To sign in', 'To verify your account', 'For MFA', 'Per accedere']) {
  authenticationMessages.push({text: purpose + ', use code 123456. Brand coupon code SAVE20'});
  ordinaryMessages.push(
    {text: 'Example: ' + purpose + ', use code 123456. Brand coupon code SAVE20'},
    {text: 'You said: ' + purpose + ', use code 123456. Brand coupon code SAVE20'},
    {text: purpose + ', do not use code 123456. Brand coupon code SAVE20'},
    {text: purpose + ', use code Brand coupon code SAVE20'}
  );
  for (const issuer of ['', 'Acme Inc.: ', 'Example Co.: ']) for (const determiner of ['', 'this ']) {
    authenticationMessages.push({text: issuer + purpose + ', use ' + determiner + 'code 123456. Brand coupon code SAVE20'});
    ordinaryMessages.push(
      {text: issuer + purpose + '. Use ' + determiner + 'code SAVE20. Brand coupon code SAVE20'},
      {text: issuer + purpose + ', do not use ' + determiner + 'code 123456. Brand coupon code SAVE20'},
      {text: 'You said: ' + issuer + purpose + ', use ' + determiner + 'code 123456. Brand coupon code SAVE20'},
      {text: 'Example: ' + issuer + purpose + ', use ' + determiner + 'code 123456. Brand coupon code SAVE20'}
    );
  }
  authenticationMessages.push({text: 'Welcome back. Acme Inc.: ' + purpose + ', use this code 123456. Brand coupon code SAVE20'});
}
ordinaryMessages.push({text: 'To verify your account discount, use code SAVE20. Brand coupon code SAVE20'});
for (const tense of ['has been', 'was']) {
  authenticationMessages.push(
    {text: 'A verification code ' + tense + ' sent to you: 123456. Brand coupon code SAVE20'},
    {text: 'Your verification code ' + tense + ' sent to you:\n"aBcDeF"'},
    {html: '<h1>A verification code ' + tense + ' sent to you:</h1><p>123456</p>'}
  );
  ordinaryMessages.push(
    {text: 'A verification code ' + tense + ' sent to you. Brand coupon code SAVE20'},
    {text: 'A verification code ' + tense + ' sent to you:\nBrand coupon code SAVE20'},
    {text: 'Example: A verification code ' + tense + ' sent to you: 123456. Brand coupon code SAVE20'},
    {text: 'Your verification code ' + tense + ' not sent to you: 123456. Brand coupon code SAVE20'}
  );
}
for (const target of ['account', 'identity']) for (const noun of ['code', 'passcode', 'PIN']) {
  for (const separator of [' ', '-']) {
    const label = target + separator + 'confirmation ' + noun;
    authenticationMessages.push(
      {text: 'Your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {text: '123456 is your ' + label},
      {subject: 'Your ' + label, text: 'Your code is 123456'},
      {html: '<h1>Your ' + label + ':</h1><p>123456</p>'},
      {text: 'Example: Your ' + label + ' is 123456. Your ' + label + ' is 654321'}
    );
    ordinaryMessages.push(
      {text: 'Example: Your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {text: 'You said your ' + label + ' is 123456. Brand coupon code SAVE20'},
      {text: 'This is not your ' + label + ': 123456. Brand coupon code SAVE20'},
      {text: 'Your ' + label + ' is missing. Brand coupon code SAVE20'}
    );
  }
}
ordinaryMessages.push(
  {text: 'Your confirmation code is 123456. Brand coupon code SAVE20'},
  {text: 'Your order confirmation code is 123456. Brand coupon code SAVE20'}
);
for (const host of ['support.acme.com', 'help.shop.example', '123.shop.example', 'HELP.SHOP.EXAMPLE', 'shop.example:8443']) {
  for (const suffix of ['', '.', '!', '?', ',', ';', '/help', '?page=help', '#help']) {
    ordinaryMessages.push({text: 'For help with your verification code: ' + host + suffix + ' Brand coupon code SAVE20'});
  }
  for (const [open, close] of [['"', '"'], ["'", "'"], ['<', '>'], ['(', ')'], ['[', ']']]) {
    ordinaryMessages.push({text: 'Your verification code: ' + open + host + close + '. Brand coupon code SAVE20'});
  }
  authenticationMessages.push({text: 'For help with your verification code: ' + host + '. Your verification code: 123456'});
}
for (const value of ['ABC.77', 'ABC.77.', 'ABC.77!', '123.456', 'CODE+VIP', 'ÈTÉ.77']) {
  authenticationMessages.push({text: 'Your verification code: ' + value});
}
for (const noun of ['code', 'passcode', 'PIN']) {
  authenticationMessages.push(
    {text: 'Use ' + noun + ' 123456 for authentication. Brand coupon code SAVE20'},
    {text: 'For authentication, use this ' + noun + ' 123456. Brand coupon code SAVE20'},
    {text: 'Use this ' + noun + ' for authentication: 123456'},
    {text: 'Use this ' + noun + ' for authentication:\n123456'},
    {text: 'Your verification ' + noun + ' for authentication is 123456'}
  );
  for (const marker of ['Example: ', 'You said: ', 'Do not ']) {
    ordinaryMessages.push({text: marker + 'use ' + noun + ' 123456 for authentication. Brand coupon code SAVE20'});
    authenticationMessages.push({text: marker + 'use ' + noun + ' 123456 for authentication. Use code 654321 for authentication'});
  }
  for (const compound of ['authentication discount', 'authentication-service', 'authentication services', 'authentication2']) {
    ordinaryMessages.push({text: 'Use code SAVE20 for ' + compound + '. Brand coupon code SAVE20'});
  }
}
for (const verb of ['asked', 'said', 'reported', 'recalled', 'remembered']) {
  for (const purpose of ['for authentication', 'to sign in']) {
    ordinaryMessages.push({text: 'You ' + verb + ': use code 123456 ' + purpose + '. Brand coupon code SAVE20'});
  }
}
for (const issuer of ['', 'Acme Inc.: ', 'A.C.M.E.: ']) for (const polite of ['', 'please ']) {
  for (const instruction of ['use code 123456 for authentication', 'use your verification code 123456']) {
    const phrase = issuer + polite + instruction;
    ordinaryMessages.push({text: 'You said: ' + phrase + '. Brand coupon code SAVE20'});
    ordinaryMessages.push({text: 'You said: use code 111111 for authentication; You said: ' + phrase + '. Brand coupon code SAVE20'});
    authenticationMessages.push({text: phrase});
    authenticationMessages.push({text: 'You said: ' + phrase + '. Use code 654321 for authentication'});
    authenticationMessages.push({text: 'You said: ' + phrase + '; Use code 654321 for authentication'});
    for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
      ordinaryMessages.push({text: 'You said: ' + open + phrase + close + '. Brand coupon code SAVE20'});
      ordinaryMessages.push({text: 'You said: ' + open + phrase + '; use code 654321 for authentication' + close + '. Brand coupon code SAVE20'});
      authenticationMessages.push({text: 'You said: ' + open + phrase + close + '. Use code 654321 for authentication'});
      authenticationMessages.push({text: 'You said: ' + open + phrase + close + '; Use code 654321 for authentication'});
    }
  }
}
authenticationMessages.push({text: 'You said: welcome back. Acme Inc.: please use code 123456 for authentication'});
for (const pronoun of ['I', 'we', 'you', 'he', 'she', 'they', 'it']) for (const modal of ['should', 'could', 'must', 'may']) {
  const report = 'You said that ' + pronoun + ' ' + modal + ' use code 123456 to sign in';
  ordinaryMessages.push({text: report + '. Brand coupon code SAVE20'});
  authenticationMessages.push({text: report + '; Use code 654321 to sign in'});
}
for (const tense of ['has been', 'was']) {
  authenticationMessages.push(
    {text: 'Your verification code ' + tense + ' sent: 123456. Brand coupon code SAVE20'},
    {text: 'Your verification code ' + tense + ' sent:\n123456'},
    {html: '<h1>Your verification code ' + tense + ' sent:</h1><p>“aBcDeF”</p>'}
  );
  ordinaryMessages.push(
    {text: 'Your verification code ' + tense + ' sent. Brand coupon code SAVE20'},
    {text: 'Your verification code ' + tense + ' sent:\nBrand coupon code SAVE20'},
    {text: 'Example: Your verification code ' + tense + ' sent: 123456. Brand coupon code SAVE20'},
    {text: 'You said your verification code ' + tense + ' sent: 123456. Brand coupon code SAVE20'},
    {text: 'Your verification code ' + tense + ' not sent: 123456. Brand coupon code SAVE20'}
  );
}
for (const subject of ['Sign in to Acme', 'Verify your email', 'Your verification code']) {
  for (const verb of ['Use', 'Enter']) for (const noun of ['code', 'passcode', 'PIN']) {
    authenticationMessages.push({subject, text: verb + ' this ' + noun + ' 123456. Brand coupon code SAVE20'});
    for (const prefix of ['Do not ', 'Example: ', 'You said that I should ']) {
      ordinaryMessages.push({subject, text: prefix + verb + ' this ' + noun + ' 123456. Brand coupon code SAVE20'});
    }
    ordinaryMessages.push(
      {subject, text: verb + ' this ' + noun + ' SAVE20 to get 20% off. Brand coupon code SAVE20'},
      {subject, text: verb + ' this ' + noun + ' HERE. Brand coupon code SAVE20'}
    );
  }
  for (const noun of ['coupon code', 'promo code', 'discount code']) {
    ordinaryMessages.push({subject, text: 'Use ' + noun + ' SAVE20\nBrand coupon code SAVE20'});
    authenticationMessages.push({subject, text: 'Use ' + noun + ' 123456 for authentication'});
  }
}
authenticationMessages.push({html: '<h1>Your verification code:</h1><p>Use code 123456.</p>'});
for (const [open, close] of [['“', '”'], ['‘', '’']]) {
  for (const value of ['ABCDEF', 'aBcDeF', 'ÈTÉ', 'ABC.77!', '123 456']) for (const stop of ['', '.', '!', '?']) {
    authenticationMessages.push({text: 'Your verification code is ' + open + value + close + stop + '\nBrand coupon code SAVE20'});
    ordinaryMessages.push({text: 'Example: Your verification code is ' + open + value + close + stop + '. Brand coupon code SAVE20'});
  }
  for (const value of ['shop.example', 'help@example.com']) {
    ordinaryMessages.push({text: 'Your verification code: ' + open + value + close + '. Brand coupon code SAVE20'});
  }
  ordinaryMessages.push(
    {text: 'Your verification code is ' + open + 'ABCDEF. Brand coupon code SAVE20'},
    {text: 'Your verification code is ' + open + 'ABCDEF' + (close === '”' ? '’' : '”') + '. Brand coupon code SAVE20'}
  );
}
for (const value of ['SAVE20', 'SAVE20!', 'ABC.77!', '“SAVE20!”', '‘SAVE20!’']) {
  for (const tail of ['at checkout for 20% off', 'in your cart for 20% off', 'to get 20% off']) {
    ordinaryMessages.push(
      {subject: 'Sign in to Acme', text: 'Use code ' + value + ' ' + tail + '. Brand coupon code SAVE20'},
      {html: '<h1>Your verification code:</h1><p>Use code ' + value + ' ' + tail + '.</p><p>Brand coupon code SAVE20</p>'}
    );
  }
  authenticationMessages.push({subject: 'Sign in to Acme', text: 'Use code ' + value + ' to sign in at checkout'});
}
for (const command of ['Use coupons.', 'Use offers.', 'Enter now.']) {
  ordinaryMessages.push(
    {subject: 'Sign in to Acme', text: command + ' Brand coupon code SAVE20'},
    {html: '<h1>Your verification code:</h1><p>' + command + '</p><p>Brand coupon code SAVE20</p>'}
  );
}
authenticationMessages.push({text: 'Use 123456 for authentication'});
for (const value of ['123456.', 'ABC.77!', '“ABCDEF”.', '‘123456’!']) {
  for (const tail of ['At checkout get 20% off', 'In your cart get 20% off', 'For your next purchase save 20%']) {
    authenticationMessages.push(
      {subject: 'Sign in to Acme', text: 'Use code ' + value + '\n' + tail + '. Brand coupon code SAVE20'},
      {subject: 'Sign in to Acme', html: '<p>Use code ' + value + '</p><p>' + tail + '. Brand coupon code SAVE20</p>'},
      {text: 'Your verification code:\nUse code ' + value + '\n' + tail + '. Brand coupon code SAVE20'},
      {html: '<h1>Your verification code:</h1><p>Use code ' + value + '</p><p>' + tail + '. Brand coupon code SAVE20</p>'}
    );
  }
}
for (const prefix of ['We assigned ', 'I assigned ', 'We have assigned ', 'Acme Inc.: We assigned ']) {
  for (const value of ['123456', 'ABC.77!', 'ÈTÉ+77']) {
    authenticationMessages.push({text: prefix + value + ' as your verification code. Brand coupon code SAVE20'});
    for (const report of ['You said: ', 'You reported that ', 'Example: ', 'If ']) {
      ordinaryMessages.push({text: report + prefix + value + ' as your verification code. Brand coupon code SAVE20'});
      authenticationMessages.push({text: report + prefix + value + ' as your verification code' +
        (report === 'Example: ' ? '. ' : '; ') + 'We assigned 654321 as your verification code'});
    }
  }
}
for (const prefix of ['We did not assign ', 'We have not assigned ', 'We could have assigned ', 'We will assign ', 'We might assign ']) {
  ordinaryMessages.push({text: prefix + '123456 as your verification code. Brand coupon code SAVE20'});
}
ordinaryMessages.push(
  {text: 'We assigned a value as your verification code. Brand coupon code SAVE20'},
  {text: 'We assigned ABCDEF as your verification code. Brand coupon code SAVE20'},
  {text: 'We assigned SAVE20 as your coupon code. Brand coupon code SAVE20'}
);
for (const [label, expiry] of [
  ['Your verification code', 'expires in 10 minutes'], ['Your login PIN', 'is valid for 1 hour'],
  ['Your security passcode', 'valid for 30 seconds'], ['Il tuo codice di verifica', 'scade tra 10 minuti'],
  ['Il tuo codice di accesso', 'scadrà fra 2 ore'], ['Il tuo codice di sicurezza', 'è valido per 30 secondi']
]) {
  for (const delimiter of [': ', ':', '= ']) for (const value of ['123456', 'ABC.77!', '“aBcDeF”']) {
    const heading = label + ' ' + expiry;
    authenticationMessages.push(
      {text: heading + delimiter + value + '\nBrand coupon code SAVE20'},
      {text: heading + delimiter.trim() + '\n' + value},
      {html: '<h1>' + heading + delimiter.trim() + '</h1><p>' + value + '</p>'},
      {subject: heading + delimiter.trim(), text: value}
    );
  }
  ordinaryMessages.push(
    {text: label + ' ' + expiry + '. Brand coupon code SAVE20'},
    {text: label + ' ' + expiry + ':\nBrand coupon code SAVE20'},
    {text: label + ' ' + expiry + ' 123456. Brand coupon code SAVE20'},
    {html: '<h1>' + label + ' ' + expiry + ':</h1><p>Brand coupon code SAVE20</p>'},
    {text: 'Example: ' + label + ' ' + expiry + ': 123456. Brand coupon code SAVE20'},
    {text: 'You said that ' + label + ' ' + expiry + ': 123456. Brand coupon code SAVE20'}
  );
}
for (const expiry of ['expires in 10', 'expires in minutes', 'expires in 10 minutes discount', 'does not expire in 10 minutes']) {
  ordinaryMessages.push({text: 'Your verification code ' + expiry + ': 123456. Brand coupon code SAVE20'});
}
for (const verb of ['Check', 'Determine', 'Find out', 'Ask']) for (const conjunction of ['if', 'whether']) {
  for (const phrase of ['your verification code is 123456', '123456 is your verification code']) {
    const question = verb + ' ' + conjunction + ' ' + phrase;
    ordinaryMessages.push({text: question + '. Brand coupon code SAVE20'});
    for (const separator of ['. ', '; ', '\n']) {
      authenticationMessages.push({text: question + separator + 'Your verification code is 654321'});
    }
    for (const [open, close] of [['"', '"'], ['“', '”']]) {
      ordinaryMessages.push({text: verb + ' ' + conjunction + ' ' + open + phrase + '; your verification code is 654321' + close + '. Brand coupon code SAVE20'});
      authenticationMessages.push({text: verb + ' ' + conjunction + ' ' + open + phrase + close + '. Your verification code is 654321'});
    }
  }
}
for (const issuer of ['If Bank', 'Whether Services']) authenticationMessages.push({text: issuer + ': Your verification code is 123456'});
for (const value of ['IF+77', 'WHETHER77']) authenticationMessages.push({text: 'Your verification code is ' + value});
for (const question of ['Can I share my', 'Could we share our', 'Should he use his', 'Can she use her',
  'Would they share their', 'Can it use its', 'Is my', 'Was their', 'Has our', 'Were your', 'Did he use his',
  'Does she use her', 'Do they use their', 'Have we received our', 'Had I received my',
  'May I share my', 'Might we use our', 'Will I use my', 'Am I using my', 'Shall we use our']) {
  for (const issuer of ['', 'Acme: ', 'Acme Inc.: ', 'Welcome. ', 'Brand offer; ']) {
    const phrase = issuer + question + ' verification code 123456';
    ordinaryMessages.push({text: phrase + '? Brand coupon code SAVE20'});
    for (const separator of ['? ', '; ', '\n']) authenticationMessages.push({text: phrase + separator + 'Your verification code is 654321'});
  }
}
for (const [open, close] of [['"', '"'], ['“', '”'], ["'", "'"], ['‘', '’']]) {
  for (const issuer of ['', 'Acme: ', 'Acme Inc.: ']) {
    const question = issuer + open + 'Can I share my verification code 123456';
    ordinaryMessages.push(
      {text: question + '?' + close + '. Brand coupon code SAVE20'},
      {text: question + '; your verification code is 654321' + close + '. Brand coupon code SAVE20'},
      {text: question.replace('code 123456', 'code: 123456') + '; your verification code is 654321' + close + '. Brand coupon code SAVE20'}
    );
    authenticationMessages.push({text: question + '?' + close + '. Your verification code is 654321'});
    authenticationMessages.push({text: question.replace('code 123456', 'code: 123456') + close + '. Your verification code is 654321'});
  }
}
for (const issuer of ['Can I Bank', 'Could We Services', 'My Bank', 'Our Services']) {
  authenticationMessages.push({text: issuer + ': Your verification code is 123456'});
}
authenticationMessages.push({text: 'I can use code 123456 to sign in'}, {text: 'Your verification code: CAN+I77'});
for (const modal of ['may', 'might', 'will', 'shall']) authenticationMessages.push({text: 'I ' + modal + ' use code 123456 to sign in'});
for (const role of ['Why should I share my', 'How can I use my', 'When would we use our',
  'Where should I enter my', "Why can't I share my", 'Why can’t I share my',
  "Shouldn't I use my", 'Shouldn’t I use my', "Won't I use my", "Isn't my", 'Isn’t my',
  'Who should use my', 'Who can share my', 'Who could use my',
  'Suppose your', 'Supposing your', 'Assume that your', 'Assuming your', 'Imagine your']) {
  const phrase = role + ' verification code is 123456';
  ordinaryMessages.push({text: phrase + '? Brand coupon code SAVE20'},
    {subject: phrase, text: 'Brand coupon code SAVE20'},
    {html: '<p>' + phrase + '?</p><p>Brand coupon code SAVE20</p>'});
  for (const separator of ['. ', '; ', '\n']) authenticationMessages.push({text: phrase + separator + 'Your verification code is 654321'});
  for (const [open, close] of [['"', '"'], ['“', '”']]) {
    ordinaryMessages.push({text: 'Acme: ' + open + phrase.replace('is 123456', ': 123456') + '; your verification code is 654321' + close + '. Brand coupon code SAVE20'});
  }
}
for (const issuer of ['Why Bank', 'Who Can Bank', 'Suppose Bank', 'Assume Services']) authenticationMessages.push({text: issuer + ': Your verification code is 123456'});
for (const value of ['123456', 'ABC.77!', '“aBc77”']) {
  for (const instruction of ['enter it to sign in', 'use this code to verify your email', 'please type the code to access your account']) {
    authenticationMessages.push({text: 'Your verification code is ' + value + ', ' + instruction + '. Brand coupon code SAVE20'});
  }
}
for (const instruction of ['enter it at checkout for 20% off', 'use it to confirm your order',
  'use it to verify your account discount', 'do not enter it to sign in', 'if you enter it to sign in',
  'you said enter it to sign in', 'enter another code 654321 at checkout']) {
  ordinaryMessages.push({text: 'Your verification code is 123456, ' + instruction + '. Brand coupon code SAVE20'});
}
for (const target of ['your account', 'your email', 'your email address', 'your identity']) {
  authenticationMessages.push({text: 'Your verification code is 123456, enter it to confirm ' + target});
  authenticationMessages.push({text: 'Your verification code to confirm ' + target + ' is 123456'});
  ordinaryMessages.push({text: 'Your verification code is 123456, enter it to confirm ' + target + ' discount. Brand coupon code SAVE20'});
}
for (const [open, close] of [['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"], ['<', '>']]) {
  ordinaryMessages.push({text: 'Your verification code is ' + open + 'support.example.com' + close + ', enter it to sign in. Brand coupon code SAVE20'});
  authenticationMessages.push({text: 'Your verification code is ' + open + 'ABC.77' + close + ', enter it to sign in'});
}
// R24 revises only the known copular all-letter fixture class. Keep its original
// sources, but assert semantic routing separately from pre-model exclusion.
// This fixture partition does not call the production admission implementation.
const alphaFixture = '["\x27“‘<][\\p{L}\\p{M}]+["\x27”’>]';
const ambiguousFixture = new RegExp('(?:is|will be|è|sarà|e[’\x27])[ \\t]+' + alphaFixture +
  '|' + alphaFixture + '[ \\t]+(?:is|è|e[’\x27])[ \\t]+', 'iu');
const ambiguousMessages = [];
for (let index = authenticationMessages.length - 1; index >= 0; index--) {
  if (ambiguousFixture.test(authenticationMessages[index].text || '')) {
    ambiguousMessages.unshift(authenticationMessages.splice(index, 1)[0]);
  }
}
module.exports = {authenticationMessages, ordinaryMessages, ambiguousMessages};
