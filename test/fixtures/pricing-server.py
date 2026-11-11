"""Cross-repository test process. SYNTHETIC DATA in a temporary database only.
Uses the external pricing repository's real service, API, schemas and test fixtures.
Never point this at a production database or reuse these deterministic test tokens.
"""
import os
import sys
import json
import socket
from datetime import datetime, timezone
from hashlib import sha256
sys.path.insert(0, os.environ['TWC_PRICING_SOURCE'])
from tests import helpers as h
from trade_pricing.api import create_app
from trade_pricing.config import ServerConfig, Principal
from trade_pricing.models import QuoteAction, Approval
import uvicorn

h.NOW = datetime.now(timezone.utc)
svc, case, calculation = h.setup_service(os.environ['TWC_PRICING_TEST_DB'])
# Test preparation only. The API uses the real progressing clock.
svc.clock = lambda: datetime.now(timezone.utc)
quotes = []
for i in range(3):
    q = svc.calculate(h.AGENT, case['id'], calculation.model_copy(update={'request_id': f'calculation-{i}'}))
    q = svc.submit(h.AGENT, q['id'], QuoteAction(**h.action_for(q, f'submit-{i}')))
    q = svc.approve(h.APPROVER, q['id'], Approval(**h.action_for(q, f'approve-{i}'), decision='approve', reason='SYNTHETIC cross-project test approval'))
    if i < 2:
        q = svc.finalize(h.APPROVER, q['id'], QuoteAction(**h.action_for(q, f'finalize-{i}')))
    quotes.append(q)
tokens = {'viewer': 'isolated-pricing-viewer-fixture-' * 2,
          'approver': 'isolated-pricing-approver-fixture-' * 2}
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.bind(('127.0.0.1', 0))
port = sock.getsockname()[1]
config = ServerConfig(tenant='factory-test', seller_name='Synthetic seller', database=os.environ['TWC_PRICING_TEST_DB'],
    port=port, origin=f'http://127.0.0.1:{port}', principals=[
        Principal(name='internal-viewer' if role == 'viewer' else 'finance-reviewer', role=role,
                  token_hash=sha256(token.encode()).hexdigest()) for role, token in tokens.items()])
print(json.dumps({'url': config.origin, 'quotes': [{k: q[k] for k in ['id','state','version','content_hash']} for q in quotes],
                  'customer': h.case_data()['customer_name']}), flush=True)
uvicorn.Server(uvicorn.Config(create_app(config, svc), log_level='warning')).run(sockets=[sock])
