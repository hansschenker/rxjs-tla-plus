# Independent request-protocol review

The primary agent delegated a read-only semantic review to a separate agent.
The reviewer inspected the RequestProtocol model and configurations, actual
RxJS 7.8.2 operator implementation, request replay adapter, runtime tests,
correspondence helper and tests, both runner integrations, and the
implementation mutation drill.

The reviewer found no substantive defect. Its checks covered:

- Next preserves request ownership even after source completion.
- Empty completion creates no value and completes output only when remaining
  work permits it.
- Inner error can follow values and closes owned work.
- Old request completion in the debounced policy preserves newer pending input;
  an error from that still-active old request terminates output.
- Accepted-value ordinals distinguish repeated payloads and are counted
  independently of model output observations by the correspondence helper.
- Reaching the model value bound does not force completion or error.
- Correct-model witness endpoints are stable through the final scheduler frame.
- The implementation mutation runs the exact same test before and after adding
  take(1) in a disposable copy, requires an ordinary named-test failure, and
  verifies the concrete early-completion/lost-value trace.

The review explicitly identified a documentation distinction: the model mutation
records invented request completion; actual take(1) unsubscribes the underlying
request. The code and documentation describe them as complementary fault checks.

## Additional execution

The reviewer ran the retained independent-probes.mjs script directly against
real RxJS and the unchanged pipelines. All 48 probes passed: 12 scenarios times
two policies times two timer orders. Closed request Subscribers are called
without consulting the production replay adapter, confirming actual library
suppression of late notifications. Frames through 10 are supplementary runtime
evidence; the model checks stop at frame 4.

| Reviewed input | SHA-256 |
|---|---|
| RequestProtocol.tla | 0cfd726b5003aa4d9f6105ca94540fe3008067f24bbe60af84f42586e4489fa7 |
| replay-request-protocol.mjs | 298f067d12bbabf3d4c17a57bf634b0c0a34a18a5b3bfcab0ab111c7bd14d079 |
| request-protocol-evidence.mjs | 076c4b5a527a02b7d2dc2401fd5719583c72eda6ce997eae2589d26c7451bb61 |
| check-protocol-mutation.mjs | b26c9ff8e156bdafd00b487b8abeb5f0218c8c63775d7676ecbd06c092fc4d74 |
| independent-probes.mjs | 76d3e37ee193d57b5e212934de55abbc95a1311494009b31958f4395b3857132 |
| independent-probes.log | f71a43847edc98aa6f4128647c7e268614b4ac8868dbda831e76bade6db61e00 |

The primary agent subsequently completed all final gates against reviewed source
4b80ea40adad33464bcc3787b797bb9c2a0444ac and checked the recorded input hashes
before archiving. The independent review is evidence about these inspected
semantics and probes, not a universal proof or approval of every final
documentation sentence.
