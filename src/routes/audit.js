const express = require('express');
const audit = require('../services/auditService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json({
    logs: audit.list({
      siteId: req.query.siteId ? Number(req.query.siteId) : null,
      action: req.query.action || null,
      limit: req.query.limit,
      offset: req.query.offset
    })
  });
});

module.exports = router;