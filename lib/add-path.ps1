param([Parameter(Mandatory = $true)][string]$Directory)
# Add $Directory to the front of the user's Path. Read and write the raw registry value so entries such as
# %USERPROFILE%\bin stay unexpanded and REG_EXPAND_SZ stays REG_EXPAND_SZ
# ([Environment]::SetEnvironmentVariable would write the expanded value as REG_SZ).
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains 'Path') { $kind = $key.GetValueKind('Path') }
  $wanted = $Directory.TrimEnd('\')
  $present = $raw -split ';' | Where-Object { $_ } | Where-Object {
    $_.TrimEnd('\') -ieq $wanted -or [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $wanted
  }
  if ($present) { return }
  $value = if ($raw) { "$Directory;$raw" } else { $Directory }
  $key.SetValue('Path', $value, $kind)
} finally {
  $key.Close()
}
# Tell running programs (Explorer, new terminals) that the environment changed.
[Environment]::SetEnvironmentVariable('PI_CONFIG_PATH_REFRESH', '1', 'User')
[Environment]::SetEnvironmentVariable('PI_CONFIG_PATH_REFRESH', $null, 'User')
