"""Rendering of core reports into rich renderables.

Kept out of the command modules so the commands stay a thin argument-parsing
layer, and so the same report can be rendered by a future web view without
dragging Typer along.
"""

from __future__ import annotations

from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from launchpilot.core.models.report import (
    Finding,
    Severity,
    Status,
    ValidationReport,
)
from launchpilot.core.models.testing import ClosedTestingStatus
from launchpilot.core.services.image_fixer import FixResult
from launchpilot.core.services.metadata_validator import MetadataReport
from launchpilot.core.services.pricing_calculator import PricingPlan
from launchpilot.core.services.submission_checker import SubmissionReadinessReport
from launchpilot.core.specs.registry import StoreSpec

SEVERITY_STYLE: dict[Severity, str] = {
    Severity.ERROR: "bold red",
    Severity.WARNING: "yellow",
    Severity.INFO: "cyan",
}

SEVERITY_ICON: dict[Severity, str] = {
    Severity.ERROR: "✗",
    Severity.WARNING: "!",
    Severity.INFO: "i",
}

STATUS_STYLE: dict[Status, str] = {
    Status.PASS: "bold green",
    Status.WARN: "bold yellow",
    Status.FAIL: "bold red",
}


def severity_text(severity: Severity) -> Text:
    return Text(
        f"{SEVERITY_ICON[severity]} {severity.value}",
        style=SEVERITY_STYLE[severity],
    )


def _finding_lines(findings: list[Finding]) -> Text:
    """One line per finding, with the hint indented beneath it."""
    body = Text()
    for i, finding in enumerate(findings):
        if i:
            body.append("\n")
        body.append(f"{SEVERITY_ICON[finding.severity]} ", style=SEVERITY_STYLE[finding.severity])
        body.append(finding.code, style=f"{SEVERITY_STYLE[finding.severity]}")
        body.append(f"  {finding.message}")
        if finding.fix_hint:
            body.append(f"\n    → {finding.fix_hint}", style="dim italic")
    return body


def render_validation(report: ValidationReport) -> RenderableType:
    table = Table(
        title=f"Screenshots · {report.directory}",
        title_style="bold",
        header_style="bold",
        expand=True,
        show_lines=True,
    )
    table.add_column("File", overflow="fold", ratio=2)
    table.add_column("Size", justify="right", no_wrap=True)
    table.add_column("Device", ratio=1)
    table.add_column("Findings", ratio=4)

    for asset in report.assets:
        facts = asset.facts
        size = f"{facts.width}×{facts.height}" if facts else "—"
        weight = f"\n{facts.size_bytes / 1_048_576:.1f} MB" if facts else ""
        findings = (
            _finding_lines(asset.findings) if asset.findings else Text("✓ clean", style="green")
        )
        table.add_row(
            Text(asset.path.name, style=STATUS_STYLE[asset.status]),
            Text(size + weight, style="dim" if not weight else ""),
            asset.device_class or "—",
            findings,
        )

    parts: list[RenderableType] = [table]
    if report.set_findings:
        parts.append(
            Panel(
                _finding_lines(report.set_findings),
                title="Directory-level",
                border_style="yellow",
                title_align="left",
            )
        )
    parts.append(_summary_panel(report))
    return Group(*parts)


def _summary_panel(report: ValidationReport) -> Panel:
    stores = ", ".join(s.value for s in report.stores)
    line = Text()
    line.append(f"{len(report.assets)} file(s) checked against ", style="dim")
    line.append(stores, style="bold")
    line.append("  ·  ")
    line.append(f"{report.error_count} error(s)", style="red" if report.error_count else "dim")
    line.append("  ·  ")
    line.append(
        f"{report.warning_count} warning(s)",
        style="yellow" if report.warning_count else "dim",
    )
    return Panel(line, border_style=STATUS_STYLE[report.status], title=report.status.value.upper())


def render_metadata(report: MetadataReport) -> RenderableType:
    table = Table(
        title="Store listing text",
        title_style="bold",
        header_style="bold",
        expand=True,
        show_lines=True,
    )
    table.add_column("Locale", no_wrap=True)
    table.add_column("Findings", ratio=5)

    for locale in report.locales:
        findings = (
            _finding_lines(locale.findings) if locale.findings else Text("✓ clean", style="green")
        )
        table.add_row(Text(locale.locale, style=STATUS_STYLE[locale.status]), findings)

    summary = Text()
    summary.append(f"{len(report.locales)} locale(s)  ·  ", style="dim")
    summary.append(f"{report.error_count} error(s)", style="red" if report.error_count else "dim")
    summary.append("  ·  ")
    summary.append(
        f"{report.warning_count} warning(s)",
        style="yellow" if report.warning_count else "dim",
    )
    return Group(
        table,
        Panel(summary, border_style=STATUS_STYLE[report.status], title=report.status.value.upper()),
    )


def render_testing_status(
    status: ClosedTestingStatus, *, synthetic: bool = False
) -> RenderableType:
    filled = int(status.progress_pct / 5)
    bar = Text("█" * filled + "░" * (20 - filled))
    bar.stylize("green" if status.eligible else "yellow")

    table = Table.grid(padding=(0, 2))
    table.add_column(style="dim", justify="right")
    table.add_column()

    verdict = (
        Text("ELIGIBLE — you can apply for production access", style="bold green")
        if status.eligible
        else Text("NOT YET ELIGIBLE", style="bold yellow")
    )
    table.add_row("Status", verdict)
    table.add_row(
        "Testers",
        Text(
            f"{status.active_testers} / {status.required_testers}",
            style="green" if status.testers_needed == 0 else "red",
        ),
    )
    table.add_row(
        "Continuous days",
        Text(f"{status.current_streak_days} / {status.required_days}"),
    )
    table.add_row("Progress", Text.assemble(bar, f"  {status.progress_pct:g}%"))
    if status.streak_started_on:
        table.add_row("Streak began", str(status.streak_started_on))
    if status.projected_eligible_date:
        table.add_row(
            "Projected date",
            Text(str(status.projected_eligible_date), style="bold cyan"),
        )
    if status.streak_was_reset:
        table.add_row(
            "⚠ Reset",
            Text("Tester count dipped — the 14-day clock restarted", style="bold red"),
        )

    parts: list[RenderableType] = [
        Panel(table, title="Google Play · Closed testing", border_style="blue", title_align="left")
    ]

    if status.blocking_reasons:
        blockers = Text()
        for i, reason in enumerate(status.blocking_reasons):
            if i:
                blockers.append("\n")
            blockers.append("• ", style="yellow")
            blockers.append(reason.message)
        parts.append(
            Panel(
                blockers,
                title="What's blocking you",
                border_style="yellow",
                title_align="left",
            )
        )

    if synthetic:
        parts.append(
            Text(
                "Note: computed from a flat tester count, so a mid-test dip cannot be "
                "detected. Use --from-file for a real day-by-day timeline.",
                style="dim italic",
            )
        )
    return Group(*parts)


def render_fix_result(result: FixResult) -> RenderableType:
    table = Table(
        title=("Planned fixes (dry run)" if result.dry_run else "Applied fixes"),
        title_style="bold",
        header_style="bold",
        expand=True,
    )
    table.add_column("File", overflow="fold", ratio=2)
    table.add_column("Actions", ratio=3)

    for plan in result.plans:
        if plan.error:
            table.add_row(Text(plan.source.name, style="red"), Text(plan.error, style="red"))
        elif not plan.changed:
            table.add_row(
                Text(plan.source.name, style="dim"),
                Text("✓ nothing to do", style="dim green"),
            )
        else:
            actions = Text()
            for i, action in enumerate(plan.actions):
                if i:
                    actions.append("\n")
                actions.append("• ", style="cyan")
                actions.append(action.code, style="bold cyan")
                actions.append(f"  {action.detail}")
            table.add_row(Text(plan.source.name, style="yellow"), actions)

    summary = Text()
    verb = "would be changed" if result.dry_run else "written to"
    summary.append(f"{result.changed_count} file(s) {verb} ", style="dim")
    if not result.dry_run:
        summary.append(str(result.output_dir), style="bold")
    if result.failed:
        summary.append(f"  ·  {len(result.failed)} failed", style="red")

    return Group(table, Panel(summary, border_style="cyan"))


_SPEC_STATUS_STYLE = {
    "required": "bold green",
    "accepted": "green",
    "legacy": "yellow",
    "deprecated": "red",
}


def render_specs(specs: list[StoreSpec]) -> RenderableType:
    """The spec catalogue, with provenance.

    Showing ``last_verified`` and the source URL is deliberate: these numbers
    drift, and a user deserves to see how stale the bundled data is.
    """
    parts: list[RenderableType] = []
    for spec in specs:
        table = Table(
            title=f"{spec.store.value.title()} · verified {spec.last_verified}",
            title_style="bold",
            header_style="bold",
            caption=spec.source_url,
            caption_style="dim",
            expand=True,
        )
        table.add_column("Device class")
        table.add_column("Portrait", justify="right", no_wrap=True)
        table.add_column("Status", no_wrap=True)
        table.add_column("Notes", ratio=2, overflow="fold")

        for size in spec.sizes:
            table.add_row(
                size.device_class,
                f"{size.width}×{size.height}",
                Text(size.status, style=_SPEC_STATUS_STYLE.get(size.status, "")),
                Text(size.notes or "", style="dim"),
            )

        rules = Text()
        rules.append("formats ", style="dim")
        rules.append(", ".join(spec.rules.formats))
        rules.append("   alpha ", style="dim")
        rules.append("allowed" if spec.rules.allow_alpha else "forbidden")
        if spec.rules.max_bytes:
            rules.append("   max size ", style="dim")
            rules.append(f"{spec.rules.max_bytes / 1_048_576:.0f} MB")
        if spec.rules.max_side_ratio:
            rules.append("   long side ≤ ", style="dim")
            rules.append(f"{spec.rules.max_side_ratio:g}× short side")

        parts.append(Group(table, Panel(rules, border_style="dim")))
    return Group(*parts)


def render_pricing(plan: PricingPlan) -> RenderableType:
    title = f"Suggested prices from {plan.base_price:g} ({plan.base_country.upper()}, {plan.model})"
    table = Table(
        title=title,
        title_style="bold",
        header_style="bold",
        expand=True,
    )
    table.add_column("Storefront")
    table.add_column("Tier")
    table.add_column("Multiplier", justify="right", no_wrap=True)
    table.add_column("Suggested price", justify="right", no_wrap=True)

    for territory in plan.territories:
        table.add_row(
            f"{territory.country_name} ({territory.country.upper()})",
            territory.tier_label or "unclassified — full rate",
            f"{territory.multiplier:.2f}×",
            f"{territory.suggested_price:.2f}",
        )

    note = Text(
        "A starting point to copy into App Store Connect / Play Console yourself — "
        "nothing here calls either API.",
        style="dim italic",
    )
    return Group(table, note)


def render_submission(report: SubmissionReadinessReport) -> RenderableType:
    parts: list[RenderableType] = []

    if report.screenshots is not None:
        parts.append(render_validation(report.screenshots))
    if report.metadata is not None:
        parts.append(render_metadata(report.metadata))
    if report.keywords is not None:
        kw = report.keywords
        findings = (
            _finding_lines(kw.findings) if kw.findings else Text("✓ nothing wasted", style="green")
        )
        parts.append(
            Panel(
                findings,
                title=f"Keyword field · {kw.length}/{kw.max_length} characters",
                border_style="dim",
                title_align="left",
            )
        )

    skipped = [name for name in ("screenshots", "metadata", "keywords") if name not in report.ran]
    summary = Text()
    summary.append(f"{len(report.ran)} of 3 checks run", style="dim")
    if skipped:
        summary.append(f"  ·  not checked: {', '.join(skipped)}", style="dim italic")
    summary.append("  ·  ")
    summary.append(f"{report.error_count} error(s)", style="red" if report.error_count else "dim")
    summary.append("  ·  ")
    summary.append(
        f"{report.warning_count} warning(s)",
        style="yellow" if report.warning_count else "dim",
    )
    parts.append(
        Panel(summary, border_style=STATUS_STYLE[report.status], title=report.status.value.upper())
    )
    return Group(*parts)
