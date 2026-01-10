class ProviderError(RuntimeError):
    pass


class ProviderUnavailableError(ProviderError):
    pass


class ProviderTimeoutError(ProviderError):
    pass


class ProviderResponseError(ProviderError):
    pass
