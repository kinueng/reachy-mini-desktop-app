import React, { useEffect } from 'react';
import { Box, CircularProgress, Typography, Button } from '@mui/material';
import WifiOffIcon from '@mui/icons-material/WifiOff';
import RefreshIcon from '@mui/icons-material/Refresh';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import FullscreenOverlay from '@components/FullscreenOverlay';
import Header from './components/Header';
import SearchBar from './components/SearchBar';
import CategoryFilters from './components/CategoryFilters';
import AppCard from './components/AppCard';
import EmptyState from './components/EmptyState';
import Footer from './components/Footer';

/**
 * Modal overlay for discovering and installing apps from Hugging Face
 */
export default function DiscoverModal({
  open: isOpen,
  onClose,
  filteredApps,
  darkMode,
  isBusy,
  isLoading,
  error,
  activeJobs,
  isJobRunning,
  handleInstall,
  getJobInfo,
  searchQuery,
  setSearchQuery,
  officialOnly,
  setOfficialOnly,
  categories,
  selectedCategory,
  setSelectedCategory,
  totalAppsCount,
  installedApps = [],
  onOpenCreateTutorial, // Callback to open Create App Tutorial modal
  hidden = false, // Hide when another overlay is on top (avoids stacked blur perf hit)
}) {
  // Removed debug logs to reduce console spam

  // ✅ Determine if filters are active
  const hasActiveFilter = selectedCategory !== null || (searchQuery && searchQuery.trim());
  const isFiltered = hasActiveFilter && filteredApps.length < totalAppsCount;

  return (
    <FullscreenOverlay
      open={isOpen}
      onClose={onClose}
      darkMode={darkMode}
      zIndex={10002} // Above settings overlay
      centeredX={true} // Center horizontally
      debugName="DiscoverModalLegacy"
      centeredY={false} // Don't center vertically
      showCloseButton={true}
      hidden={hidden}
    >
      <Box
        sx={{
          width: '90%',
          maxWidth: '700px',
          display: 'flex',
          flexDirection: 'column',
          mt: 8,
          mb: 4,
        }}
      >
        {/* Header */}
        <Header darkMode={darkMode} />

        {/* Search Bar */}
        <SearchBar
          darkMode={darkMode}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          officialOnly={officialOnly}
          setOfficialOnly={setOfficialOnly}
          isLoading={isLoading}
          filteredApps={filteredApps}
          totalAppsCount={totalAppsCount}
          isFiltered={isFiltered}
        />

        {/* Category Filters */}
        <CategoryFilters
          darkMode={darkMode}
          categories={categories}
          selectedCategory={selectedCategory}
          setSelectedCategory={setSelectedCategory}
          totalAppsCount={totalAppsCount}
        />

        {/* Apps List */}
        <Box
          sx={{
            position: 'relative',
          }}
        >
          {/* Warning banner if there's an error but apps are available */}
          {error && filteredApps.length > 0 && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                px: 2.5,
                py: 1.5,
                mb: 2,
                borderRadius: '10px',
                backgroundColor: darkMode ? 'rgba(255, 149, 0, 0.12)' : 'rgba(255, 149, 0, 0.08)',
                border: `1px solid ${darkMode ? 'rgba(255, 149, 0, 0.3)' : 'rgba(255, 149, 0, 0.25)'}`,
              }}
            >
              <WifiOffIcon
                sx={{
                  fontSize: 20,
                  color: darkMode ? '#fbbf24' : '#f59e0b',
                  flexShrink: 0,
                }}
              />
              <Typography
                sx={{
                  fontSize: 13,
                  color: darkMode ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.8)',
                  fontWeight: 500,
                  flex: 1,
                }}
              >
                {error}
              </Typography>
            </Box>
          )}

          {/* Full error screen if there's an error and no apps to show */}
          {error && filteredApps.length === 0 ? (
            <Box
              sx={{
                py: 10,
                textAlign: 'center',
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <WifiOffIcon
                sx={{
                  fontSize: 56,
                  color: darkMode ? '#666' : '#999',
                  opacity: 0.7,
                  mb: 1,
                }}
              />
              <Typography
                sx={{
                  fontSize: 15,
                  color: darkMode ? 'rgba(255, 255, 255, 0.9)' : 'rgba(0, 0, 0, 0.87)',
                  fontWeight: 600,
                  mb: 0.5,
                }}
              >
                No Internet Connection
              </Typography>
              <Typography
                sx={{
                  fontSize: 13,
                  color: darkMode ? '#888' : '#666',
                  fontWeight: 400,
                  maxWidth: 320,
                  lineHeight: 1.6,
                  mb: 2,
                }}
              >
                {error}
              </Typography>
              <Button
                variant="outlined"
                startIcon={<RefreshIcon />}
                onClick={() => window.location.reload()}
                sx={{
                  textTransform: 'none',
                  fontSize: 13,
                  fontWeight: 500,
                  px: 3,
                  py: 1,
                  borderRadius: '8px',
                  borderColor: darkMode ? '#444' : '#ddd',
                  color: darkMode ? '#aaa' : '#666',
                  '&:hover': {
                    borderColor: darkMode ? '#555' : '#ccc',
                    backgroundColor: darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                  },
                }}
              >
                Retry
              </Button>
            </Box>
          ) : isLoading ? (
            <Box
              sx={{
                py: 10,
                textAlign: 'center',
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 2,
              }}
            >
              <CircularProgress
                size={40}
                sx={{
                  color: darkMode ? '#666' : '#999',
                }}
              />
              <Typography
                sx={{
                  fontSize: 14,
                  color: darkMode ? '#888' : '#999',
                  fontWeight: 500,
                }}
              >
                Loading apps...
              </Typography>
            </Box>
          ) : (
            <Box
              sx={{
                display: 'flex',
                flexDirection: 'row',
                flexWrap: 'wrap',
                gap: 2.5,
                width: '100%',
                mb: 0,
              }}
            >
              {filteredApps.length === 0 ? (
                <EmptyState
                  darkMode={darkMode}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                />
              ) : (
                <>
                  {filteredApps.map((app, index) => {
                    const installJob = getJobInfo(app.name, 'install');
                    const isInstalling = isJobRunning(app.name, 'install');
                    const installFailed = installJob && installJob.status === 'failed';
                    const isInstalled = app.isInstalled || false;

                    return (
                      <AppCard
                        key={`${app.name}-${selectedCategory || 'all'}-${searchQuery || ''}-${index}`}
                        app={app}
                        darkMode={darkMode}
                        isBusy={isBusy}
                        isInstalling={isInstalling}
                        installFailed={installFailed}
                        isInstalled={isInstalled}
                        handleInstall={handleInstall}
                        selectedCategory={selectedCategory}
                        searchQuery={searchQuery}
                        index={index}
                      />
                    );
                  })}

                  {/* Footer */}
                  {filteredApps.length > 0 && (
                    <Footer darkMode={darkMode} onOpenCreateTutorial={onOpenCreateTutorial} />
                  )}
                </>
              )}
            </Box>
          )}
        </Box>
      </Box>
    </FullscreenOverlay>
  );
}
