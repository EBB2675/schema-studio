"""
Celery application for background jobs (graph build + diff).
The broker/backend are configured via environment variables to stay flexible
for different deployment targets (Redis/Rabbit/etc).
"""
from __future__ import annotations

import logging
import os
from celery import Celery

log = logging.getLogger(__name__)


def _bool_env(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.lower() in {"1", "true", "yes", "on"}


def create_celery() -> Celery:
    broker_url = os.getenv("CELERY_BROKER_URL")
    backend_url = os.getenv("CELERY_RESULT_BACKEND", broker_url)

    # In dev it's convenient to run eagerly when no broker is configured.
    eager_default = broker_url is None
    app = Celery("schema_uml", broker=broker_url or "memory://localhost/", backend=backend_url or None, include=["api.tasks"])

    app.conf.update(
        task_default_queue=os.getenv("CELERY_TASK_DEFAULT_QUEUE", "schema-uml"),
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        enable_utc=True,
        timezone=os.getenv("CELERY_TIMEZONE", "UTC"),
        task_soft_time_limit=int(os.getenv("CELERY_TASK_SOFT_TIME_LIMIT", "240")),
        task_time_limit=int(os.getenv("CELERY_TASK_TIME_LIMIT", "300")),
        worker_max_tasks_per_child=int(os.getenv("CELERY_WORKER_MAX_TASKS", "100")),
        broker_connection_retry_on_startup=True,
        task_send_sent_event=True,
        result_expires=int(os.getenv("CELERY_RESULT_EXPIRES", "3600")),
        task_always_eager=_bool_env("CELERY_TASK_ALWAYS_EAGER", eager_default),
        task_eager_propagates=True,
    )

    if app.conf.task_always_eager:
        log.warning(
            "Celery is running in eager mode (synchronous). "
            "Set CELERY_BROKER_URL / CELERY_RESULT_BACKEND and start a worker for production."
        )
    return app


celery_app = create_celery()


def celery_enabled() -> bool:
    """
    True when Celery will send tasks to a broker (i.e., not eager/in-memory).
    """
    return not celery_app.conf.task_always_eager


__all__ = ["celery_app", "celery_enabled"]
