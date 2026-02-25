import React, { useState, useMemo, useEffect } from 'react';
import { Box, Typography, Tooltip } from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useActiveRobotContext } from '../../context';
import {
  useApps,
  useAppHandlers,
  useAppInstallation,
  useAppFiltering,
  useModalStack,
} from '../../application-store/hooks';
import { InstalledAppsSection } from '../../application-store/installed';
import { Modal as DiscoverModal } from '../../application-store/discover';
import { CreateAppTutorial as CreateAppTutorialModal } from '../../application-store/modals';
import { Overlay as InstallOverlay } from '../../application-store/installation';
import SimulationDisclaimer from './SimulationDisclaimer';
import { isSimulationMode } from '../../../../utils/simulationMode';

/**
 * Applications Section - Displays installed and available apps from Hugging Face
 * Uses ActiveRobotContext for decoupling from global stores
 */
export default function ApplicationsSection({
  showToast,
  onLoadingChange,
  hasQuickActions = false, // To adjust padding-top of AccordionSummary
  isActive = false,
  isBusy = false,
  darkMode = false,
}) {
  const { robotState, actions } = useActiveRobotContext();

  // Get values from context with prop fallbacks
  const {
    darkMode: contextDarkMode,
    isActive: contextIsActive,
    installingAppName,
    installJobType,
    installResult,
    installStartTime,
  } = robotState;

  const effectiveDarkMode = darkMode !== undefined ? darkMode : contextDarkMode;
  const effectiveIsActive = isActive !== undefined ? isActive : contextIsActive;
  const effectiveIsBusy = isBusy !== undefined ? isBusy : actions.isBusy();

  // State
  const [officialOnly, setOfficialOnly] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // ✅ Modal stack hook - declared BEFORE useAppInstallation to avoid stale closure
  const { openModal, closeModal, discoverModalOpen, createAppTutorialModalOpen } = useModalStack();

  // Apps data hook
  const {
    availableApps,
    installedApps,
    currentApp,
    activeJobs,
    installApp,
    removeApp,
    startApp,
    stopCurrentApp,
    fetchAvailableApps,
    isLoading,
    isStoppingApp,
    error: appsError,
  } = useApps(effectiveIsActive, officialOnly);

  // Notify parent when loading status changes
  useEffect(() => {
    if (onLoadingChange) {
      onLoadingChange(isLoading);
    }
  }, [isLoading, onLoadingChange]);

  // Reset category when switching between official/non-official
  useEffect(() => {
    setSelectedCategory(null);
  }, [officialOnly]);

  // Installation lifecycle hook
  useAppInstallation({
    activeJobs,
    installedApps,
    showToast,
    refreshApps: fetchAvailableApps,
    isLoading,
    onInstallSuccess: () => {
      if (discoverModalOpen) {
        closeModal();
      }
    },
  });

  // App action handlers
  const {
    expandedApp,
    setExpandedApp,
    startingApp,
    handleInstall,
    handleUninstall,
    handleStartApp,
    isJobRunning,
    getJobInfo,
  } = useAppHandlers({
    currentApp,
    activeJobs,
    installApp,
    removeApp,
    startApp,
    stopCurrentApp,
    showToast,
  });

  const installingApp = useMemo(() => {
    if (!installingAppName) return null;
    const found = availableApps.find(app => app.name === installingAppName);
    if (found) return found;
    return {
      name: installingAppName,
      id: installingAppName,
      description: '',
      url: null,
      source_kind: 'local',
      isInstalled: false,
      extra: {},
    };
  }, [installingAppName, availableApps]);

  const activeJobsArray = Array.from(activeJobs.values());
  const installingJob = installingAppName
    ? activeJobsArray.find(job => job.appName === installingAppName)
    : null;

  // ✅ Filter & sort apps client-side (data is cached for 1 day)
  const { categories, filteredApps } = useAppFiltering(
    availableApps,
    searchQuery,
    selectedCategory,
    officialOnly
  );

  // Check if we're in simulation mode
  const inSimulationMode = isSimulationMode();

  return (
    <>
      <Box>
        <Box
          sx={{
            px: 3,
            py: 1,
            pt: hasQuickActions ? 1 : 0,
            bgcolor: 'transparent',
          }}
        >
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
              <Typography
                sx={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: effectiveDarkMode ? '#f5f5f5' : '#333',
                  letterSpacing: '-0.3px',
                }}
              >
                Applications
              </Typography>
              {installedApps.length > 0 && (
                <Typography
                  sx={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: effectiveDarkMode ? '#666' : '#999',
                  }}
                >
                  {installedApps.length}
                </Typography>
              )}
              <Tooltip
                title="Apps that are currently installed on your robot. You can start, stop, configure, or uninstall them from here."
                arrow
                placement="top"
              >
                <InfoOutlinedIcon
                  sx={{
                    fontSize: 14,
                    color: effectiveDarkMode ? '#666' : '#999',
                    opacity: 0.6,
                    cursor: 'help',
                  }}
                />
              </Tooltip>
            </Box>
            <Typography
              sx={{
                fontSize: 12,
                color: effectiveDarkMode ? '#888' : '#999',
                fontWeight: 500,
              }}
            >
              Extend Reachy's capabilities
            </Typography>
          </Box>
        </Box>
        {/* Apps list container with simulation disclaimer overlay */}
        <Box sx={{ px: 0, mb: 0, bgcolor: 'transparent', position: 'relative' }}>
          {/* Simulation mode disclaimer - only covers the apps list box */}
          {inSimulationMode && <SimulationDisclaimer darkMode={effectiveDarkMode} />}

          <InstalledAppsSection
            installedApps={installedApps}
            darkMode={effectiveDarkMode}
            expandedApp={expandedApp}
            setExpandedApp={setExpandedApp}
            startingApp={startingApp}
            currentApp={currentApp}
            isBusy={effectiveIsBusy}
            isJobRunning={isJobRunning}
            isStoppingApp={isStoppingApp}
            handleStartApp={handleStartApp}
            handleUninstall={handleUninstall}
            getJobInfo={getJobInfo}
            stopCurrentApp={stopCurrentApp}
            onOpenDiscover={() => openModal('discover')}
            onOpenCreateTutorial={() => openModal('createTutorial')}
          />
        </Box>
      </Box>

      <DiscoverModal
        open={discoverModalOpen}
        onClose={closeModal}
        filteredApps={filteredApps}
        darkMode={effectiveDarkMode}
        isBusy={effectiveIsBusy}
        isLoading={isLoading}
        error={appsError}
        activeJobs={activeJobs}
        isJobRunning={isJobRunning}
        handleInstall={handleInstall}
        getJobInfo={getJobInfo}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        officialOnly={officialOnly}
        setOfficialOnly={setOfficialOnly}
        categories={categories}
        selectedCategory={selectedCategory}
        setSelectedCategory={setSelectedCategory}
        totalAppsCount={availableApps.length}
        installedApps={installedApps}
        onOpenCreateTutorial={() => openModal('createTutorial')}
      />

      <CreateAppTutorialModal
        open={createAppTutorialModalOpen}
        onClose={closeModal}
        darkMode={effectiveDarkMode}
      />

      {installingAppName && installingApp && (
        <InstallOverlay
          appInfo={installingApp}
          jobInfo={
            installingJob || { type: installJobType || 'install', status: 'starting', logs: [] }
          }
          darkMode={effectiveDarkMode}
          jobType={installJobType || 'install'}
          resultState={installResult}
          installStartTime={installStartTime}
        />
      )}
    </>
  );
}
