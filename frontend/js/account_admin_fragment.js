/* Reference fragment for the live admin dashboard layout block. */
        '<div class="grid2-wide">' +
          '<div class="panel tool-panel">' + ragone + '</div>' +
          '<div class="panel usage-panel"><h2>Tool usage</h2>' + usageHtml(usage) + '</div>' +
        '</div>' +
        '<div class="section-gap"></div>' +
        '<div class="grid-cells">' +
          cellsPanel +
          activityHtml +
        '</div>' +
        '<div class="section-gap"></div>' +
        '<div class="panel accounts-panel"><h2>Accounts</h2>' + accountsSection + '</div>' +
        '<div class="section-gap"></div>' +
        signature +
        bottomBar +
        '</div>';
