// input: test runner process environment
// output: AISTATUS_UPLOAD_ENABLED=0 for every test process, so a developer's ~/.aistatus/config.yaml never makes tests upload to aistatus.cc
// pos: preloaded via `node --import` by the npm test script; tests that exercise uploads opt in with configure() or an explicit UsageUploader config
// >>> 一旦我被更新，务必更新我的开头注释，以及所属文件夹的 CLAUDE.md <<<

process.env.AISTATUS_UPLOAD_ENABLED = "0";
