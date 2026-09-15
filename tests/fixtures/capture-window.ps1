Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Tongpin Capture Test'
$form.ClientSize = New-Object System.Drawing.Size(760, 440)
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#145f48')
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'TONGPIN LIVE'
$title.ForeColor = [System.Drawing.Color]::White
$title.Font = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(185, 125)
$form.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Local video capture test'
$subtitle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#d2eb76')
$subtitle.Font = New-Object System.Drawing.Font('Segoe UI', 18)
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(235, 205)
$form.Controls.Add($subtitle)

$clock = New-Object System.Windows.Forms.Label
$clock.ForeColor = [System.Drawing.Color]::White
$clock.Font = New-Object System.Drawing.Font('Consolas', 23)
$clock.AutoSize = $true
$clock.Location = New-Object System.Drawing.Point(245, 260)
$form.Controls.Add($clock)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.Add_Tick({ $clock.Text = Get-Date -Format 'HH:mm:ss.fff' })
$timer.Start()

[void]$form.ShowDialog()
