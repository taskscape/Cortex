; Cortex online installer. Build-Installer.ps1 supplies a curated source payload.
; Dependencies are installed on the target PC by the existing Cortex launcher.
#ifndef PayloadDir
  #error PayloadDir must be supplied by Build-Installer.ps1
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef OutputDir
  #define OutputDir "Output"
#endif
; Docker Desktop 4.93.0 (Windows x64), pinned to Docker's 2026-09-28
; release notes and published SHA-256. Refresh both for later releases.
#define DockerInstallerUrl "https://desktop.docker.com/win/main/amd64/240920/Docker%20Desktop%20Installer.exe"
#define DockerInstallerSha256 "c139124c9cf71477dc565c3c0ea5a18f90b93d68ebe9aaa848a065960416c0bc"

[Setup]
AppId={{95A071A4-AB42-4F9F-8127-8A1E6551A584}
AppName=Cortex
AppVersion={#AppVersion}
AppPublisher=Taskscape Ltd
DefaultDirName={localappdata}\Programs\Cortex
DefaultGroupName=Cortex
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19045
OutputDir={#OutputDir}
OutputBaseFilename=Cortex-{#AppVersion}-win-x64-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
CloseApplications=no
UninstallDisplayName=Cortex Local Agent

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "templates\matbot.yaml"; DestDir: "{app}\local-agent\matbot"; Flags: onlyifdoesntexist uninsneveruninstall
Source: "templates\workspaces.json"; DestDir: "{app}\local-agent\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
; Starts missing local services and then opens the Cortex website in the default browser.
Name: "{group}\Cortex"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\scripts\open-cortex.ps1"""; WorkingDir: "{app}"
Name: "{group}\Open Cortex website"; Filename: "http://localhost:19778/"
Name: "{group}\Uninstall Cortex"; Filename: "{uninstallexe}"

[Run]
Filename: "http://localhost:19778/"; Description: "Open Cortex website"; Flags: shellexec postinstall skipifsilent nowait

[Code]
var
  CredentialPage: TInputQueryWizardPage;
  DockerDownloadPage: TDownloadWizardPage;
  CredentialPath: String;

function FindDockerCli(): String;
begin
  Result := FileSearch('docker.exe', GetEnv('PATH'));
  if Result = '' then
    Result := ExpandConstant('{localappdata}\Programs\DockerDesktop\resources\bin\docker.exe');
  if not FileExists(Result) then
    Result := ExpandConstant('{pf64}\Docker\Docker\resources\bin\docker.exe');
  if not FileExists(Result) then
    Result := '';
end;

procedure InitializeWizard;
begin
  CredentialPage := CreateInputQueryPage(wpSelectDir,
    'Provider credential', 'Configure Cortex for its first run',
    'Enter an OpenAI API key. Leave it blank on an upgrade to reuse the existing user-scoped key. The value is not written to the Setup log.');
  CredentialPage.Add('OpenAI API key:', True);
  DockerDownloadPage := CreateDownloadPage('Downloading Docker Desktop',
    'Cortex needs Docker Desktop for its local memory and database services.', nil);
  DockerDownloadPage.ShowBaseNameInsteadOfUrl := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ExistingKey: String;
begin
  Result := True;
  if CurPageID <> CredentialPage.ID then Exit;
  if (CredentialPage.Values[0] = '') and
     (not RegQueryStringValue(HKCU, 'Environment', 'OPENAI_API_KEY', ExistingKey) or
      (ExistingKey = '')) then
  begin
    MsgBox('Enter an OpenAI API key to configure Cortex.', mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  NodePath: String;
  VersionMS, VersionLS: Cardinal;
  DockerInstaller: String;
  ResultCode: Integer;
begin
  Result := '';
  NodePath := FileSearch('node.exe', GetEnv('PATH'));
  if (NodePath = '') or not GetVersionNumbers(NodePath, VersionMS, VersionLS) or
     ((VersionMS shr 16) < 24) then
  begin
    Result := 'Node.js 24 or newer is required. Install it from https://nodejs.org/ and run Cortex Setup again.';
    Exit;
  end;
  if FindDockerCli() <> '' then Exit;

  DockerDownloadPage.Clear;
  DockerDownloadPage.Add('{#DockerInstallerUrl}',
    'Docker Desktop Installer.exe', '{#DockerInstallerSha256}');
  DockerDownloadPage.Show;
  try
    try
      DockerDownloadPage.Download;
    except
      if DockerDownloadPage.AbortedByUser then
        Result := 'Docker Desktop download was cancelled.'
      else
        Result := 'Could not download or verify Docker Desktop: ' + GetExceptionMessage;
    end;
  finally
    DockerDownloadPage.Hide;
  end;
  if Result <> '' then Exit;

  DockerInstaller := ExpandConstant('{tmp}\Docker Desktop Installer.exe');
  if not Exec(DockerInstaller, 'install --user', ExpandConstant('{tmp}'),
    SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := 'Could not start the Docker Desktop installer.';
    Exit;
  end;
  if ResultCode = 3010 then
  begin
    NeedsRestart := True;
    Result := 'Docker Desktop requires a Windows restart. Restart, then run Cortex Setup again.';
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    Result := Format('Docker Desktop setup failed (exit %d).', [ResultCode]);
    Exit;
  end;
  if FindDockerCli() = '' then
    Result := 'Docker Desktop setup completed but its CLI was not found. Sign in again, then run Cortex Setup.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Params: String;
begin
  if CurStep <> ssPostInstall then Exit;
  CredentialPath := ExpandConstant('{tmp}\cortex-provider-key.txt');
  if not SaveStringToFile(CredentialPath, CredentialPage.Values[0], False) then
    RaiseException('Could not create the temporary credential file.');
  try
    WizardForm.StatusLabel.Caption := 'Configuring and starting Cortex. Initial dependency downloads can take several minutes...';
    Params := '-NoProfile -ExecutionPolicy Bypass -File "' +
      ExpandConstant('{app}\scripts\install-cortex-package.ps1') +
      '" -CredentialFile "' + CredentialPath + '"';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      Params, ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then
      RaiseException('Could not start Cortex setup.');
    if ResultCode <> 0 then
      RaiseException(Format('Cortex setup failed (exit %d). See %s.', [ResultCode,
        ExpandConstant('{app}\local-agent\logs\installer-setup.log')]));
  finally
    DeleteFile(CredentialPath);
  end;
end;

procedure DeinitializeSetup;
begin
  if CredentialPath <> '' then DeleteFile(CredentialPath);
end;
